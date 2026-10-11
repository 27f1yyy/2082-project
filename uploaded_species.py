"""Validated, persistent user-uploaded species GeoTIFF layers.

Uploaded rasters are aligned with the original Victoria COST grid. Only
positive raster values at valid planning units count as species presence.
The core Pyomo formulations are intentionally unchanged.
"""

import json
import os
import re
import tempfile
from pathlib import Path
from threading import Lock
from uuid import uuid4

import numpy as np
import rasterio
from rasterio.errors import RasterioIOError

UPLOAD_DIR = Path(__file__).resolve().parent / "uploaded_species"
REGISTRY_FILE = UPLOAD_DIR / "registry.json"
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MiB per uploaded GeoTIFF
CHUNK_BYTES = 1024 * 1024
_REGISTRY_LOCK = Lock()
_VALID_ID = re.compile(r"^uploaded_[0-9a-f]{32}$")


class SpeciesUploadError(ValueError):
    """A raster file or species name does not meet import requirements."""


def _load_registry_unlocked():
    if not REGISTRY_FILE.exists():
        return {}
    with REGISTRY_FILE.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise RuntimeError("The uploaded-species registry is invalid")
    return data


def _save_registry_unlocked(registry):
    # Atomic replacement avoids partial JSON writes if the server stops.
    with tempfile.NamedTemporaryFile(
        mode="w", encoding="utf-8", suffix=".json",
        dir=UPLOAD_DIR, delete=False
    ) as handle:
        temp_path = Path(handle.name)
        try:
            json.dump(registry, handle, indent=2, ensure_ascii=False)
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise
    os.replace(temp_path, REGISTRY_FILE)


def list_uploaded_species():
    """Return metadata (no file paths) for previously uploaded species."""
    with _REGISTRY_LOCK:
        registry = _load_registry_unlocked()
    return [dict(entry) for entry in registry.values()]


def _check_name(name, existing_names, registry):
    cleaned = name.strip()
    if not cleaned or len(cleaned) > 100:
        raise SpeciesUploadError("Species name must have 1–100 characters")
    used = {str(x).casefold() for x in existing_names}
    used.update(str(x["name"]).casefold() for x in registry.values())
    if cleaned.casefold() in used:
        raise SpeciesUploadError("A species with this name already exists")
    return cleaned


def _presence_vector(path, rows, cols):
    with rasterio.open(path) as dataset:
        values = dataset.read(1, masked=True)[rows, cols]
    unmasked = np.asarray(np.ma.filled(values, 0), dtype=float)
    if not np.isfinite(unmasked).all():
        raise SpeciesUploadError("Raster contains non-finite values in valid planning units")
    return (unmasked > 0).astype(np.int8)


def _validate_raster(path, cost_raster, rows, cols):
    try:
        with rasterio.open(path) as uploaded:
            if uploaded.driver != "GTiff":
                raise SpeciesUploadError("Upload a GeoTIFF raster (.tif or .tiff)")
            if uploaded.count != 1:
                raise SpeciesUploadError("The uploaded raster must have exactly one band")
            if uploaded.width != cost_raster.width or uploaded.height != cost_raster.height:
                raise SpeciesUploadError(
                    f"Grid size mismatch. Expected {cost_raster.width} x {cost_raster.height} pixels"
                )
            if uploaded.crs != cost_raster.crs or uploaded.crs is None:
                raise SpeciesUploadError(
                    f"CRS mismatch. Expected {cost_raster.crs}"
                )
            if not uploaded.transform.almost_equals(cost_raster.transform, precision=1e-8):
                raise SpeciesUploadError(
                    "Grid origin, pixel size or alignment differs from the Victoria cost raster"
                )
            if np.dtype(uploaded.dtypes[0]).kind not in "biuf":
                raise SpeciesUploadError("Raster values must be numeric")
        present = _presence_vector(path, rows, cols)
    except (RasterioIOError, OSError) as exc:
        raise SpeciesUploadError(f"Unable to open a valid GeoTIFF: {exc}") from exc
    presence_count = int(present.sum())
    if presence_count == 0:
        raise SpeciesUploadError("Species has no positive presence in valid planning units")
    return presence_count


def register_species_file(file_obj, original_filename, species_name, cost_raster,
                          rows, cols, existing_names):
    """Copy, validate, then persist an uploaded species raster and its metadata.

    Only generated UUIDs are used as filenames; never trust the client path.
    """
    if not original_filename or Path(original_filename).suffix.lower() not in {".tif", ".tiff"}:
        raise SpeciesUploadError("Choose a .tif or .tiff GeoTIFF file")

    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with _REGISTRY_LOCK:
        cleaned_name = _check_name(species_name, existing_names, _load_registry_unlocked())

    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".tif", dir=UPLOAD_DIR, delete=False) as temporary:
            tmp_path = Path(temporary.name)
            written = 0
            while True:
                chunk = file_obj.read(CHUNK_BYTES)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise SpeciesUploadError("GeoTIFF is larger than the 50 MiB upload limit")
                temporary.write(chunk)
        if written == 0:
            raise SpeciesUploadError("Uploaded file is empty")
        presence_count = _validate_raster(tmp_path, cost_raster, rows, cols)

        with _REGISTRY_LOCK:
            registry = _load_registry_unlocked()
            _check_name(cleaned_name, existing_names, registry)
            species_id = f"uploaded_{uuid4().hex}"
            destination = UPLOAD_DIR / f"{species_id}.tif"
            entry = {
                "id": species_id,
                "name": cleaned_name,
                "source": "uploaded",
                "planning_units_present": presence_count,
            }
            os.replace(tmp_path, destination)
            tmp_path = None
            registry[species_id] = entry
            try:
                _save_registry_unlocked(registry)
            except Exception:
                destination.unlink(missing_ok=True)
                raise
        return entry
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)


def append_uploaded_species(data, entries, target_pct):
    """Append uploaded species to the planning unit × species matrix."""
    if not entries:
        return data
    vectors = []
    for entry in entries:
        species_id = entry["id"]
        if not _VALID_ID.fullmatch(species_id):
            raise RuntimeError("Invalid registered uploaded-species ID")
        path = UPLOAD_DIR / f"{species_id}.tif"
        try:
            vectors.append(_presence_vector(path, data["rows"], data["cols"]))
        except (RasterioIOError, OSError) as exc:
            raise RuntimeError(f"Uploaded species file unavailable: {species_id}") from exc

    new_amount = np.column_stack(vectors)
    data["amount"] = np.column_stack((data["amount"], new_amount))
    data["species_units"].extend(
        np.flatnonzero(new_amount[:, j])
        for j in range(new_amount.shape[1])
    )
    new_targets = np.ceil(target_pct * new_amount.sum(axis=0)).astype(int)
    data["target"] = np.concatenate((data["target"], new_targets))
    data["species_ids"].extend(entry["id"] for entry in entries)
    data["n_species"] = len(data["species_ids"])
    return data
