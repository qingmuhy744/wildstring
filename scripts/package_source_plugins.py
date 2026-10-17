"""Create independently importable source plugin ZIPs from maintained adapter sources."""

import argparse
import ast
import importlib.util
import json
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend/src"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=ROOT / "artifacts/source-plugins")
    args = parser.parse_args()
    source = ROOT / "plugins/community_adapters.py"
    spec = importlib.util.spec_from_file_location("community_adapters", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    tree = ast.parse(source.read_text())
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name in ("QQPlugin", "KuGouPlugin", "NeteasePlugin"):
        plugin = getattr(module, name)()
        keep = (
            {"clean", "positive", name, "QQTransport"}
            if name == "QQPlugin"
            else {"clean", "positive", "bridge", name}
        )
        body = [
            node
            for node in tree.body
            if isinstance(node, ast.Import | ast.ImportFrom | ast.Assign)
            or isinstance(node, ast.FunctionDef | ast.ClassDef)
            and node.name in keep
        ]
        body.extend(
            ast.parse(f"""from lyric_formats import normalize_bundle
class Plugin({name}):
    def lyrics(self, context, candidate):
        raw = super().lyrics(context, candidate)
        raw["normalized"] = normalize_bundle(raw, self.manifest.id)
        return raw
""").body
        )
        adapter = ast.unparse(ast.fix_missing_locations(ast.Module(body=body, type_ignores=[])))
        path = args.output_dir / f"wildstring-{plugin.manifest.id}-{plugin.manifest.version}.zip"
        with ZipFile(path, "w", ZIP_DEFLATED) as archive:
            archive.writestr(
                "manifest.json", json.dumps(plugin.manifest.public(), ensure_ascii=False, indent=2)
            )
            archive.writestr("adapter.py", adapter + "\n")
            if plugin.manifest.id in {"kugou", "netease"}:
                runtime = ROOT / ".cache/source-runtimes"
                archive.write(runtime / (plugin.manifest.id + ".cjs"), "service.cjs")
                archive.write(
                    runtime / (plugin.manifest.id + "-THIRD-PARTY-NOTICES.txt"),
                    "THIRD-PARTY-NOTICES.txt",
                )
            archive.write(ROOT / "plugins/lyric_formats.py", "lyric_formats.py")
            archive.write(ROOT / "LICENSE", "LICENSE")
            archive.writestr(
                "README.txt",
                f"WildString source plugin API v1\nUpstream: {plugin.manifest.upstream}\nLicense: {plugin.manifest.license}\nOfficial image: Python 3.12 + Node 22 + QQ SDK. Import and enable; external service URL is optional.\nOnly metadata and lyrics; no audio download.\n",
            )
        print(path.name)


if __name__ == "__main__":
    main()
