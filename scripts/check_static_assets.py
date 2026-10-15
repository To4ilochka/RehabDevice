import argparse
import gzip
import mimetypes
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen


PROJECT_DIR = Path(__file__).resolve().parents[1]
COMPRESSED_SUFFIXES = {".html", ".css", ".js", ".json", ".svg", ".txt"}
MIME_TYPES = {
    ".html": {"text/html"},
    ".css": {"text/css"},
    ".js": {"text/javascript", "application/javascript"},
    ".json": {"application/json"},
    ".svg": {"image/svg+xml"},
    ".woff": {"font/woff"},
    ".woff2": {"font/woff2"},
    ".ttf": {"font/ttf"},
}


def check_http(base_url, logical_path, source):
    request = Request(
        base_url.rstrip("/") + quote(logical_path, safe="/?="),
        headers={"Accept-Encoding": "gzip"},
    )
    with urlopen(request, timeout=10) as response:
        assert response.status == 200, logical_path
        expected_types = MIME_TYPES.get(
            source.suffix,
            {mimetypes.guess_type(source.name)[0] or "application/octet-stream"},
        )
        actual_type = response.headers.get_content_type()
        assert actual_type in expected_types, (logical_path, actual_type)
        encoding = response.headers.get("Content-Encoding")
        body = response.read()
        if source.suffix in COMPRESSED_SUFFIXES:
            assert encoding == "gzip", (logical_path, encoding)
            body = gzip.decompress(body)
        else:
            assert encoding is None, (logical_path, encoding)
        assert body == source.read_bytes(), f"Stale HTTP asset: {logical_path}"
        cache_control = response.headers.get("Cache-Control", "")
        assert "no-cache" in cache_control or "no-store" in cache_control, (
            logical_path, cache_control
        )
        print(f"HTTP OK {logical_path}: {actual_type}, encoding={encoding}, {cache_control}")


def main():
    parser = argparse.ArgumentParser(description="Verify staged or extracted LittleFS UI assets and optional live HTTP delivery.")
    parser.add_argument(
        "--asset-dir", type=Path,
        default=PROJECT_DIR / ".pio/build/esp32dev_RehabDevice/data_compressed",
    )
    parser.add_argument("--base-url", help="Device URL, e.g. http://rehab.local")
    args = parser.parse_args()
    data_dir = PROJECT_DIR / "data"
    expected_files = set()
    for source in sorted(data_dir.rglob("*")):
        if not source.is_file():
            continue
        relative = source.relative_to(data_dir).as_posix()
        compressed = source.suffix in COMPRESSED_SUFFIXES
        packed_name = relative + ".gz" if compressed else relative
        expected_files.add(packed_name)
        packed = (args.asset_dir / packed_name).read_bytes()
        actual = gzip.decompress(packed) if compressed else packed
        assert actual == source.read_bytes(), f"Stale packed asset: {relative}"
        if args.base_url:
            check_http(args.base_url, "/" + relative, source)
    actual_files = {
        path.relative_to(args.asset_dir).as_posix()
        for path in args.asset_dir.rglob("*") if path.is_file()
    }
    assert actual_files == expected_files, f"Unexpected files: {actual_files - expected_files}"
    print(f"PASS: {len(expected_files)} packed assets match their sources")
    if args.base_url:
        check_http(args.base_url, "/", data_dir / "index.html")
        check_http(args.base_url, "/app.js?v=7", data_dir / "app.js")


if __name__ == "__main__":
    main()