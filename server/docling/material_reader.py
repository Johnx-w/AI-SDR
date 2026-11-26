"""Project citations projected from an unmodified upstream DoclingDocument."""

import json
import sys
from io import BytesIO

from docling.datamodel.backend_options import MarkdownBackendOptions
from docling.datamodel.base_models import ConversionStatus, DocumentStream, InputFormat
from docling.datamodel.pipeline_options import NativePdfPipelineOptions
from docling.document_converter import (
    DocumentConverter,
    MarkdownFormatOption,
    NativePdfFormatOption,
)
from docling_core.types.doc import PictureItem, TableItem, TextItem


def image_data(picture):
    if picture.image is None:
        return None
    uri = str(picture.image.uri)
    return uri.split(",", 1)[1] if uri.startswith("data:image/") else None


def spreadsheet(doc):
    sheets = {}
    pictures = []
    for group in doc.groups:
        if group.label.value == "sheet":
            sheets[group.self_ref] = {"sheet": group.name, "data": [], "merges": []}

    def put(sheet, row, col, value, height=1, width=1):
        if row < 0 or col < 0 or row + height > 20000 or col + width > 150:
            raise ValueError("每张工作表最多 20000 行、150 列")
        if not value:
            return
        data = sheet["data"]
        while len(data) <= row:
            data.append([])
        data[row].extend([None] * (col + 1 - len(data[row])))
        data[row][col] = value
        if height > 1 or width > 1:
            sheet["merges"].append(
                {
                    "s": {"r": row, "c": col},
                    "e": {"r": row + height - 1, "c": col + width - 1},
                }
            )

    def sheet_for(item):
        node = item
        while node.parent:
            if node.parent.cref in sheets:
                return sheets[node.parent.cref]
            node = node.parent.resolve(doc)
        return None

    for item in [*doc.tables, *doc.texts, *doc.pictures]:
        sheet = sheet_for(item)
        if sheet is None or not item.prov:
            continue
        box = item.prov[0].bbox
        row, col = int(box.t), int(box.l)
        if isinstance(item, TableItem):
            for c in item.data.table_cells:
                put(
                    sheet,
                    row + c.start_row_offset_idx,
                    col + c.start_col_offset_idx,
                    c.text,
                    c.row_span,
                    c.col_span,
                )
        elif isinstance(item, PictureItem):
            pictures.append(
                {
                    "sheet": sheet["sheet"],
                    "row": row + 1,
                    "col": col,
                    "singleRow": box.b == box.t + 1,
                    "image": image_data(item),
                }
            )
        elif item.parent.cref in sheets:
            put(sheet, row, col, item.text)
    return {"sheets": list(sheets.values()), "pictures": pictures}


def office(doc):
    blocks, cells, nearby = [], {}, {}
    cell_contents = set()
    for table in doc.tables:
        for cell in table.data.table_cells:
            ref = getattr(cell, "ref", None)
            if ref:
                cell_contents.update(
                    child.self_ref
                    for child, _ in doc.iterate_items(root=ref.resolve(doc))
                )
    items = [
        item for item, _ in doc.iterate_items() if item.self_ref not in cell_contents
    ]
    for index, item in enumerate(items):
        page = item.prov[0].page_no if item.prov else 1
        if isinstance(item, PictureItem):
            neighbors = items[max(0, index - 1) : index] + items[index + 1 : index + 2]
            nearby[item.self_ref] = " ".join(
                other.text
                for other in neighbors
                if isinstance(other, TextItem)
                and (not other.prov or other.prov[0].page_no == page)
            )
        elif isinstance(item, TextItem):
            if item.text.strip():
                blocks.append({"page": page, "text": item.text})
        elif isinstance(item, TableItem):
            rows = [[c.text for c in row] for row in item.data.grid]
            blocks.append({"page": page, "rows": rows})
            for cell in item.data.table_cells:
                ref = getattr(cell, "ref", None)
                if ref:
                    cells[ref.cref] = (rows[0], rows[cell.start_row_offset_idx])
    for picture in doc.pictures:
        page = picture.prov[0].page_no if picture.prov else 1
        node = picture
        while node.parent and node.self_ref not in cells:
            node = node.parent.resolve(doc)
        headers, row = cells.get(node.self_ref, ([], []))
        blocks.append(
            {
                "page": page,
                "picture": True,
                "image": image_data(picture),
                "caption": " ".join(
                    filter(
                        None, [picture.caption_text(doc), nearby.get(picture.self_ref)]
                    )
                ),
                "headers": headers,
                "row": row,
            }
        )
    return {"blocks": blocks, "pageCount": max(len(doc.pages), 1)}


def pdf(doc):
    pages = {page: {"regions": [], "lines": []} for page in doc.pages}
    for item in [*doc.texts, *doc.pictures]:
        for prov in item.prov:
            page = pages[prov.page_no]
            size = doc.pages[prov.page_no].size
            box = prov.bbox.to_top_left_origin(page_height=size.height)
            if isinstance(item, PictureItem):
                if (
                    box.width < 5
                    or box.height < 5
                    or box.area() > size.width * size.height * 0.8
                ):
                    continue
                norm = box.normalized(size)
                page["regions"].append(
                    [
                        max(0, min(1000, round(v * 1000)))
                        for v in (norm.l, norm.t, norm.r, norm.b)
                    ]
                )
            else:
                page["lines"].append([item.text, (box.t + box.b) * 500 / size.height])
    return {"pages": pages}


def pdf_table_images(pages, source):
    """Match native picture rectangles to the image column of a ruled source table."""
    import pdfplumber

    with pdfplumber.open(BytesIO(source)) as pdf_file:
        for page in pdf_file.pages:
            original = pages.get(page.page_number)
            if not original or not original["regions"]:
                continue
            matches = {}
            for table in page.find_tables():
                header, image_cols = [], []
                for row, values in zip(table.rows, table.extract()):
                    values = [" ".join((v or "").split()) for v in values]
                    cols = [
                        i
                        for i, v in enumerate(values)
                        if v.lower()
                        in {
                            "photo",
                            "photos",
                            "picture",
                            "pictures",
                            "image",
                            "images",
                            "产品图片",
                            "图片",
                            "配图",
                            "系列参考图",
                        }
                    ]
                    if cols:
                        header, image_cols = values, cols
                        continue
                    for col in image_cols:
                        cell = row.cells[col]
                        if not cell:
                            continue
                        left, top, right, bottom = [
                            v * 1000 / (page.width if i % 2 == 0 else page.height)
                            for i, v in enumerate(cell)
                        ]
                        for index, (l, t, r, b) in enumerate(original["regions"]):
                            if (
                                left - 1 <= l
                                and top - 1 <= t
                                and right + 1 >= r
                                and bottom + 1 >= b
                            ):
                                matches.setdefault(index, []).append(
                                    {"headers": header, "row": values}
                                )
            original["cells"] = {
                i: rows[0] for i, rows in matches.items() if len(rows) == 1
            }
            page.close()


def main():
    ext = sys.argv[1]
    if len(sys.argv) == 3 and sys.argv[2] == "quote":
        from quote_catalog import parse_quote

        output = parse_quote(sys.stdin.buffer.read(), ext)
        sys.stdout.buffer.write(json.dumps(output, ensure_ascii=False).encode("utf-8"))
        return
    fmt = {
        "xlsx": InputFormat.XLSX,
        "docx": InputFormat.DOCX,
        "pptx": InputFormat.PPTX,
        "md": InputFormat.MD,
        "pdf": InputFormat.PDF,
    }[ext]
    converter = DocumentConverter(
        allowed_formats=[fmt],
        format_options={
            InputFormat.MD: MarkdownFormatOption(
                backend_options=MarkdownBackendOptions(fetch_images=True)
            ),
            InputFormat.PDF: NativePdfFormatOption(
                pipeline_options=NativePdfPipelineOptions(
                    parser_threads=2, generate_picture_images=False
                )
            ),
        },
    )
    source = sys.stdin.buffer.read()
    result = converter.convert(
        DocumentStream(name="material." + ext, stream=BytesIO(source))
    )
    if result.status != ConversionStatus.SUCCESS:
        raise ValueError("文档未完整解析")
    output = (spreadsheet if ext == "xlsx" else pdf if ext == "pdf" else office)(
        result.document
    )
    if ext == "pdf":
        pdf_table_images(output["pages"], source)
    sys.stdout.buffer.write(
        json.dumps(output, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )


if __name__ == "__main__":
    main()
