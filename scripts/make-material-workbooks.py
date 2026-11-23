"""Make two 50 MiB XLSX revisions and a valid, one-byte-larger copy for import QA."""

import argparse
from io import BytesIO
from pathlib import Path
from shutil import copyfile
from struct import pack
from zipfile import ZipFile, ZipInfo
from zlib import compress, crc32


def png_chunk(kind, data):
    return pack(">I", len(data)) + kind + data + pack(">I", crc32(kind + data))


def cover_image(budget):
    width = 4096
    # Reserve space for PNG headers and zlib's stored-block boundaries.
    height = (budget - 16384) // (width * 3 + 1)
    scanline = b"\0" + bytes(range(256)) * (width * 3 // 256)
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + png_chunk(b"IDAT", compress(scanline * height, level=0))
        + png_chunk(b"IEND", b"")
    )


def write_workbook(path, material):
    target = 50 * 1024**2
    source = Path(__file__).resolve().parents[1] / "tests/fixtures/mail-specimen.xlsx"
    with ZipFile(source) as original:
        parts = {name: original.read(name) for name in original.namelist()}
    parts["xl/worksheets/sheet1.xml"] = parts["xl/worksheets/sheet1.xml"].replace(
        b">Aluminium<", b">" + material + b"<", 1
    )
    parts["[Content_Types].xml"] = parts["[Content_Types].xml"].replace(
        b"</Types>", b'<Default Extension="png" ContentType="image/png"/></Types>'
    )
    parts["_rels/.rels"] = parts["_rels/.rels"].replace(
        b"</Relationships>",
        b'<Relationship Id="rCover" Target="docProps/thumbnail.png" '
        b'Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>'
        b"</Relationships>",
    )
    parts["docProps/thumbnail.png"] = b""

    def archive(destination):
        with ZipFile(destination, "w") as book:
            for name, data in parts.items():
                book.writestr(ZipInfo(name), data)

    skeleton = BytesIO()
    archive(skeleton)
    parts["docProps/thumbnail.png"] = cover_image(target - skeleton.tell())
    archive(path)
    # A legal ZIP comment fills the last fraction of one image scanline exactly.
    remaining = target - path.stat().st_size
    assert 0 <= remaining < 65535
    with ZipFile(path, "a") as book:
        book.comment = b"." * remaining
    assert path.stat().st_size == target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    directory = parser.parse_args().directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    write_workbook(directory / "catalog-v1.xlsx", b"Aluminium")
    revised = directory / "catalog-v2.xlsx"
    write_workbook(revised, b"Stainless steel")
    over = directory / "catalog-over.xlsx"
    copyfile(revised, over)
    with ZipFile(over, "a") as book:
        book.comment += b"."
    for name in ("catalog-v1.xlsx", "catalog-v2.xlsx", "catalog-over.xlsx"):
        path = directory / name
        with ZipFile(path) as book:
            assert book.testzip() is None
        print(f"{path.name}  {path.stat().st_size:,} bytes")
