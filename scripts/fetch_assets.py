"""Fetch the 3D assets used by the replay page into web/assets/.

Usage: python scripts/fetch_assets.py [--dry-run]
Re-running skips files that already exist. The fetched files are committed, so GitHub Pages
needs no build step; this script records exactly where each one came from.

Licences (see web/assets/CREDITS.md):
- Props, textures and the HDRI sky: Poly Haven, CC0 (https://polyhaven.com/license)
- AI agent robot: "RobotExpressive" by Tomas Laulhe (Quaternius), CC0, via the three.js examples
- Customer: "Adventurer" from Quaternius's Ultimate Modular Women pack, CC0
- Manager: "Suit" by Quaternius (Ultimate Modular Men pack), credited as CC BY
"""
import json
import pathlib
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1] / "web" / "assets"
UA = {"User-Agent": "agent-evals-lab-asset-fetch/1.0"}

MODELS = [  # Poly Haven ids, 1k textures
    "CashRegister_01", "wooden_display_shelves_01", "cardboard_box_01", "potted_plant_04",
    "wall_clock", "modern_ceiling_lamp_01", "metal_office_desk", "WetFloorSign_01",
]
TEXTURES = {  # Poly Haven id: maps
    "herringbone_parquet": ("diff", "nor", "arm"),
    "painted_plaster_wall": ("diff", "nor"),
    "wood_table_001": ("diff", "nor"),
}
HDRI = "brown_photostudio_02"
MAP_KEYS = {"diff": "Diffuse", "nor": "nor_gl", "arm": "arm"}
CHARACTERS = {  # file name: source URL
    "robot.glb": "https://cdn.jsdelivr.net/gh/mrdoob/three.js@r160/examples/models/gltf/RobotExpressive/RobotExpressive.glb",
    "customer.glb": "https://cdn.jsdelivr.net/gh/soulwax/Ophelias-Dream@main/assets/characters/quaternius_modular_women/adventurer.glb",
    "manager.glb": "https://cdn.jsdelivr.net/gh/rickphobia/ai_projects@main/projects/happy-cotton/assets/quaternius-modular-men/suit.glb",
}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


def save(url, path, dry):
    if dry or path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(get(url))


def main():
    dry = "--dry-run" in sys.argv
    total = 0
    for m in MODELS:
        files = json.loads(get(f"https://api.polyhaven.com/files/{m}"))["gltf"]["1k"]["gltf"]
        size = files["size"] + sum(f["size"] for f in files["include"].values())
        total += size
        print(f"model    {m:28} {size / 1e6:5.2f} MB")
        save(files["url"], ROOT / "models" / m / f"{m}.gltf", dry)
        for rel, f in files["include"].items():
            save(f["url"], ROOT / "models" / m / rel, dry)
    for t, maps in TEXTURES.items():
        files = json.loads(get(f"https://api.polyhaven.com/files/{t}"))
        for short in maps:
            f = files[MAP_KEYS[short]]["1k"]["jpg"]
            total += f["size"]
            save(f["url"], ROOT / "textures" / t / f"{short}.jpg", dry)
        print(f"texture  {t}")
    f = json.loads(get(f"https://api.polyhaven.com/files/{HDRI}"))["hdri"]["1k"]["hdr"]
    total += f["size"]
    save(f["url"], ROOT / "hdri" / f"{HDRI}.hdr", dry)
    print(f"hdri     {HDRI}")
    for name, url in CHARACTERS.items():
        save(url, ROOT / "characters" / name, dry)
        print(f"character {name}")
    print(f"{'would fetch' if dry else 'fetched'} about {total / 1e6:.1f} MB of Poly Haven files plus 3 characters")


if __name__ == "__main__":
    main()
