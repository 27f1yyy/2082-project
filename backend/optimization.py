import numpy as np
import pandas as pd
import rasterio
from rasterio.warp import transform
import pyomo.environ as pyo
from pyomo.opt import SolverFactory, TerminationCondition

SOLVER_NAME = "gurobi"

COST_URL = "https://github.com/jeffreyhanson/robust.prioritizr.data/releases/download/v1.0.0/cost.tif"
PA_URL = "https://github.com/jeffreyhanson/robust.prioritizr.data/releases/download/v1.0.0/pa.tif"
SPECIES_URL = "https://github.com/jeffreyhanson/robust.prioritizr.data/releases/download/v1.0.0/species.tif"
SPECIES_DETAIL_URL = "https://github.com/jeffreyhanson/robust.prioritizr.data/releases/download/v1.0.0/species.csv"

def load_data():
    cost = rasterio.open(COST_URL)
    pa = rasterio.open(PA_URL)
    species = rasterio.open(SPECIES_URL)

    species_detail = pd.read_csv(SPECIES_DETAIL_URL)

    return cost, pa, species, species_detail

def get_historic_species_ids(species_detail):
    """Return species IDs in the same order as the raster's 1990 bands."""
    years = species_detail["name"].astype(str).str.rsplit("_", n=1).str[-1]
    return species_detail.loc[years.eq("1990"), "species"].astype(str).tolist()


def prepare_data(cost, species, species_detail, target_pct=0.30, selected_species=None):

    # Find historic (1990) species layers
    species_detail = species_detail.copy()

    species_detail["year"] = [
        name.split("_")[-1]
        for name in species_detail["name"]
    ]

    species_detail["historic"] = species_detail["year"] == "1990"

    is_historic = species_detail["historic"].to_numpy()

    # Read cost raster
    cost_arr = cost.read(1)

    # Find valid planning units
    valid_mask = cost_arr != cost.nodata
    rows, cols = np.where(valid_mask)

    # Cost of each planning unit
    pu_cost = cost_arr[rows, cols].astype(float)

    # Each row of species_detail corresponds to one 1-indexed raster band.
    # Keep the original row order when filtering to avoid selecting wrong bands.
    historic_indices = np.flatnonzero(is_historic)
    historic_ids = (
        species_detail.iloc[historic_indices]["species"].astype(str).to_numpy()
    )

    if selected_species is not None:
        requested = set(selected_species)
        unknown = requested.difference(historic_ids)
        if unknown:
            raise ValueError(f"Unknown species: {sorted(unknown)[:5]}")
        chosen = np.isin(historic_ids, list(requested))
        historic_indices = historic_indices[chosen]
        historic_ids = historic_ids[chosen]

    # Rasterio bands are 1-indexed, while dataframe rows are 0-indexed.
    historic_bands = (historic_indices + 1).tolist()
    # An empty list is allowed internally when the user selects ONLY uploaded
    # species. Those new species are appended before calling a solver.
    if historic_bands:
        species_stack = species.read(historic_bands)
        amount = (species_stack[:, rows, cols] > 0).astype(int).T
    else:
        amount = np.empty((len(rows), 0), dtype=int)

    n_units = len(pu_cost)
    n_species = amount.shape[1]

    # Which planning units contain each species?
    species_units = [
        np.nonzero(amount[:, j])[0]
        for j in range(n_species)
    ]

    # Calculate conservation targets
    species_total = amount.sum(axis=0)

    target = np.ceil(
        target_pct * species_total
    ).astype(int)

    return {
        "pu_cost": pu_cost,
        "amount": amount,
        "species_units": species_units,
        "target": target,
        "n_units": n_units,
        "n_species": n_species,
        "species_ids": historic_ids.tolist(),
        "rows": rows,
        "cols": cols,
    }

def build_min_set_model(data):
    pu_cost = data["pu_cost"]
    species_units = data["species_units"]
    target = data["target"]
    n_units = data["n_units"]
    n_species = data["n_species"]

    m = pyo.ConcreteModel(name="min_set_cover")

    # Planning units
    m.I = pyo.RangeSet(0, n_units - 1)

    # Species
    m.J = pyo.RangeSet(0, n_species - 1)

    # x[i] = 1 if planning unit i is selected
    m.x = pyo.Var(m.I, domain=pyo.Binary)

    # Minimize total cost
    m.obj = pyo.Objective(
        expr=sum(
            pu_cost[i] * m.x[i]
            for i in m.I
        ),
        sense=pyo.minimize
    )

    # Each species must meet its conservation target
    def target_rule(m, j):
        return sum(
            m.x[i]
            for i in species_units[j]
        ) >= target[j]

    m.meet_target = pyo.Constraint(
        m.J,
        rule=target_rule
    )

    return m

def run_min_set(data):
    model = build_min_set_model(data)

    solver = SolverFactory(SOLVER_NAME)

    result = solver.solve(
        model,
        tee=False
    )

    if result.solver.termination_condition != TerminationCondition.optimal:
        raise RuntimeError(
            f"Solver did not find an optimal solution: "
            f"{result.solver.termination_condition}"
        )

    selected = np.array([
        pyo.value(model.x[i])
        for i in model.I
    ]) > 0.5

    total_cost = float(
        sum(
            data["pu_cost"][i]
            for i in range(data["n_units"])
            if selected[i]
        )
    )

    return {
        "selected": selected,
        "total_cost": total_cost,
        "planning_units_selected": int(selected.sum())
    }

def build_min_shortfall_model(data, budget):
    pu_cost = data["pu_cost"]
    species_units = data["species_units"]
    target = data["target"]
    n_units = data["n_units"]
    n_species = data["n_species"]

    m = pyo.ConcreteModel(name="min_shortfall")

    m.I = pyo.RangeSet(0, n_units - 1)
    m.J = pyo.RangeSet(0, n_species - 1)

    # x[i] = 1 if planning unit i is selected
    m.x = pyo.Var(m.I, domain=pyo.Binary)

    # shortfall[j] = unmet target for species j
    m.shortfall = pyo.Var(
        m.J,
        domain=pyo.NonNegativeReals
    )

    # Minimize total shortfall
    m.obj = pyo.Objective(
        expr=sum(
            m.shortfall[j]
            for j in m.J
        ),
        sense=pyo.minimize
    )

    # Amount protected + shortfall must meet target
    def target_rule(m, j):
        return (
            sum(
                m.x[i]
                for i in species_units[j]
            )
            + m.shortfall[j]
            >= target[j]
        )

    m.meet_target = pyo.Constraint(
        m.J,
        rule=target_rule
    )

    # Total cost cannot exceed budget
    m.budget_constraint = pyo.Constraint(
        expr=sum(
            pu_cost[i] * m.x[i]
            for i in m.I
        ) <= budget
    )

    return m

def run_min_shortfall(data, budget):
    model = build_min_shortfall_model(data, budget)

    solver = SolverFactory(SOLVER_NAME)

    result = solver.solve(
        model,
        tee=True
    )

    if result.solver.termination_condition != TerminationCondition.optimal:
        raise RuntimeError(
            f"Solver did not find an optimal solution: "
            f"{result.solver.termination_condition}"
        )

    selected = np.array([
        pyo.value(model.x[i])
        for i in model.I
    ]) > 0.5

    shortfalls = np.array([
        pyo.value(model.shortfall[j])
        for j in model.J
    ])

    total_cost = float(
        sum(
            data["pu_cost"][i]
            for i in range(data["n_units"])
            if selected[i]
        )
    )

    return {
        "selected": selected,
        "shortfalls": shortfalls,
        "total_cost": total_cost,
        "total_shortfall": float(shortfalls.sum()),
        "species_fully_met": int((shortfalls <= 1e-6).sum()),
        "planning_units_selected": int(selected.sum())
    }

def selected_units_to_geojson(data, selected, cost_raster):
    rows = data["rows"][selected]
    cols = data["cols"][selected]

    features = []

    for row, col in zip(rows, cols):

        # Get upper-left and lower-right corners
        left, top = rasterio.transform.xy(
            cost_raster.transform,
            row,
            col,
            offset="ul"
        )

        right, bottom = rasterio.transform.xy(
            cost_raster.transform,
            row,
            col,
            offset="lr"
        )

        # Create the cell boundary
        xs = [left, right, right, left, left]
        ys = [top, top, bottom, bottom, top]

        # EPSG:3577 -> EPSG:4326
        longitudes, latitudes = transform(
            cost_raster.crs,
            "EPSG:4326",
            xs,
            ys
        )

        coordinates = [
            [float(lon), float(lat)]
            for lon, lat in zip(longitudes, latitudes)
        ]

        features.append({
            "type": "Feature",
            "properties": {},
            "geometry": {
                "type": "Polygon",
                "coordinates": [coordinates]
            }
        })

    return {
        "type": "FeatureCollection",
        "features": features
    }
    


if __name__ == "__main__":
    cost, pa, species, species_detail = load_data()

    data = prepare_data(
        cost,
        species,
        species_detail,
        target_pct=0.30
    )

    print("Planning units:", data["n_units"])
    print("Species:", data["n_species"])

    print("\nRunning minimum set optimization...")

    min_set_result = run_min_set(data)

    print("Minimum set finished!")
    print(
        "Planning units selected:",
        min_set_result["planning_units_selected"]
    )
    print(
        "Total cost:",
        min_set_result["total_cost"]
    )

    # Use 50% of minimum-set cost
    budget = min_set_result["total_cost"] * 0.5

    print("\nBudget:", budget)
    print("Running minimum shortfall optimization...")

    shortfall_result = run_min_shortfall(
        data,
        budget
    )

    print("Minimum shortfall finished!")
    print(
        "Planning units selected:",
        shortfall_result["planning_units_selected"]
    )
    print(
        "Total cost:",
        shortfall_result["total_cost"]
    )
    print(
        "Species fully met:",
        shortfall_result["species_fully_met"],
        "/",
        data["n_species"]
    )
    print(
        "Total shortfall:",
        shortfall_result["total_shortfall"]
    )
