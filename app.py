from typing import Literal, Optional
from time import perf_counter

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from backend.optimization import (
    get_historic_species_ids,
    load_data,
    prepare_data,
    run_min_set,
    run_min_shortfall,
    selected_units_to_geojson,
)
from backend.uploaded_species import (
    SpeciesUploadError,
    append_uploaded_species,
    list_uploaded_species,
    register_species_file,
)

# Start from project root:
# python -m uvicorn backend.app:app --reload
app = FastAPI(title="Conservation Planning API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5500", "http://localhost:5500"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class OptimizationRequest(BaseModel):
    formulation: Literal["min_set", "min_shortfall"] = "min_shortfall"
    target_pct: float = Field(gt=0, le=1)
    budget: Optional[float] = Field(default=None, ge=0)
    # None: all 1990 species (original behavior).
    # A supplied list may combine original and uploaded species IDs.
    selected_species: Optional[list[str]] = None


cost, pa, species, species_detail = load_data()
HISTORIC_SPECIES_IDS = get_historic_species_ids(species_detail)
HISTORIC_SPECIES_SET = set(HISTORIC_SPECIES_IDS)


@app.get("/")
def home():
    return {"message": "Conservation Planning API is running"}


@app.get("/species")
def list_species():
    # Keep the 'species' field unchanged to avoid breaking the current frontend.
    # The upcoming frontend update can use the uploaded_species field.
    return {
        "total_species": len(HISTORIC_SPECIES_IDS),
        "species": [
            {"id": species_id, "name": species_id}
            for species_id in HISTORIC_SPECIES_IDS
        ],
        "uploaded_species": list_uploaded_species(),
    }


@app.get("/species/uploads")
def list_custom_species():
    """List previously imported custom species."""
    uploaded = list_uploaded_species()
    return {"total_uploaded_species": len(uploaded), "species": uploaded}


@app.post("/species/upload", status_code=201)
def upload_species(name: str = Form(...), file: UploadFile = File(...)):
    """Register a one-band GeoTIFF aligned exactly to Victoria's cost raster."""
    # Use the same valid-planning-unit mask that prepare_data uses.
    cost_array = cost.read(1)
    rows, cols = np.where(cost_array != cost.nodata)
    try:
        entry = register_species_file(
            file.file,
            file.filename,
            name,
            cost,
            rows,
            cols,
            existing_names=HISTORIC_SPECIES_SET,
        )
    except SpeciesUploadError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"message": "Species uploaded successfully", "species": entry}


@app.post("/optimize")
def optimize(request: OptimizationRequest):
    request_start = perf_counter()
    if request.formulation == "min_shortfall" and request.budget is None:
        raise HTTPException(
            status_code=422,
            detail="budget is required when formulation is 'min_shortfall'",
        )

    uploaded_entries = {entry["id"]: entry for entry in list_uploaded_species()}
    if request.selected_species is None:
        historic_to_run = None  # all historical species, no custom uploads
        custom_to_run = []
    else:
        ids = request.selected_species
        if not ids:
            raise HTTPException(status_code=422, detail="Select at least one species")
        if len(ids) != len(set(ids)):
            raise HTTPException(status_code=422, detail="Duplicate species IDs in selection")
        unknown = set(ids) - HISTORIC_SPECIES_SET - set(uploaded_entries)
        if unknown:
            raise HTTPException(
                status_code=422,
                detail="Unknown species IDs: " + ", ".join(sorted(unknown)[:5]),
            )
        historic_to_run = [species_id for species_id in ids if species_id in HISTORIC_SPECIES_SET]
        custom_to_run = [uploaded_entries[species_id] for species_id in ids if species_id in uploaded_entries]

    data = prepare_data(
        cost,
        species,
        species_detail,
        target_pct=request.target_pct,
        selected_species=historic_to_run,
    )
    # A user may select only uploaded species: prepare_data supports 0 historic
    # columns and these are appended before a solver is called.
    append_uploaded_species(data, custom_to_run, request.target_pct)

    preparation_done = perf_counter()

    if request.formulation == "min_set":
        result = run_min_set(data)
        species_fully_met = int(data["n_species"])
        total_shortfall = 0.0
    else:
        result = run_min_shortfall(data, request.budget)
        species_fully_met = result["species_fully_met"]
        total_shortfall = result["total_shortfall"]

    solver_done = perf_counter()
    selected_units = selected_units_to_geojson(data, result["selected"], cost)
    response_ready = perf_counter()

    return {
        "formulation": request.formulation,
        "planning_units_selected": result["planning_units_selected"],
        "total_cost": result["total_cost"],
        "species_fully_met": species_fully_met,
        "total_species": data["n_species"],
        "total_shortfall": total_shortfall,
        "selected_units": selected_units,
        # Timings are server-side wall-clock measurements in seconds.
        # Solver time includes model construction and the solver call.
        "timing": {
            "preparation_seconds": round(preparation_done - request_start, 3),
            "solver_seconds": round(solver_done - preparation_done, 3),
            "geojson_seconds": round(response_ready - solver_done, 3),
            "total_seconds": round(response_ready - request_start, 3),
        },
    }
