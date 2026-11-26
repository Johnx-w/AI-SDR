"""Read local quote tables. Each image must belong to the same physical table cell as its row."""

import base64
import io
import json
import re
from collections import Counter


def clean(value):
    return " ".join(str(value if value is not None else "").split())


def key(value):
    return re.sub(r"[\s.：:（）()_-]", "", clean(value).casefold())


HEADERS = {
    "model": {
        "型号或品名",
        "型号",
        "货号",
        "产品编码",
        "sku",
        "model",
        "modelno",
        "productioncode",
        "productcode",
    },
    "name": {"品名", "产品名称", "商品名称", "item", "itemname", "productname"},
    "photo": {"图片", "产品图片", "配图", "photo", "photos", "picture", "image"},
    "unit": {"单位", "计价单位", "unit", "uom"},
    "price": {
        "参考价格",
        "对客参考价",
        "报价",
        "单价",
        "unitprice",
        "referenceprice",
        "price",
    },
    "currency": {"币种", "currency"},
    "variant": {"工艺", "款式", "workmanship", "variant"},
    "source": {"来源", "原表位置", "source"},
}


def role(h):
    s = key(h)
    if re.fullmatch(r"(unitprice|参考价格|单价)(\$|usd|rmb|cny|eur|€|¥)", s):
        return "price"
    return next((k for k, choices in HEADERS.items() if s in choices), "")


def layout(headers):
    roles = [role(h) for h in headers]
    if roles.count("price") != 1 or not ("model" in roles or "name" in roles):
        return None
    # A second buying, tax or tier price needs a human to name the outward price.
    if any(
        re.search(r"进价|成本|含税价|未税价|不含税|price|cost", key(h)) and r != "price"
        for h, r in zip(headers, roles)
    ):
        return None
    if any(roles.count(r) > 1 for r in HEADERS):
        return None
    return {r: roles.index(r) for r in roles if r}


def ambiguous_header(values):
    return any(role(v) in {"model", "name"} for v in values) and any(
        re.search(r"price|cost|价", key(v)) for v in values
    )


def thumbnail(image):
    from PIL import Image

    if image.width * image.height > 32_000_000:
        raise ValueError("图片分辨率过大")
    image.thumbnail((700, 700))
    bg = Image.new("RGB", image.size, "white")
    rgba = image.convert("RGBA")
    bg.paste(rgba, mask=rgba.getchannel("A"))
    out = io.BytesIO()
    bg.save(out, "JPEG", quality=87)
    return base64.b64encode(out.getvalue()).decode("ascii")


def picture(blob):
    from PIL import Image

    with Image.open(io.BytesIO(blob)) as im:
        return thumbnail(im)


class Catalog:
    def __init__(self):
        self.rows, self.terms, self.warnings, self.figures = [], [], [], []
        self.page_count = 0
        self.image_bytes = 0

    def row(self, headers, loc, values, sheet, number, source, group=""):
        def get(r):
            return clean(values[loc[r]]) if r in loc and loc[r] < len(values) else ""

        item = get("model") or get("name")
        if not item:
            return None
        if not get("model") and get("variant"):
            item += " · " + get("variant")
        price = get("price")
        if (
            not item
            or len(item) > 300
            or item == clean(headers[loc.get("model", loc.get("name"))])
        ):
            return None
        match = re.fullmatch(
            r"(USD|CNY|RMB|EUR|GBP|[$€¥£])?\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(USD|CNY|RMB|EUR|GBP|[$€¥£])?",
            price,
            re.IGNORECASE,
        )
        if price and not match:
            self.warnings.append(f"{source} · 单价“{price[:75]}”请核对，未写入报价。")
        denom = re.search(
            r"(USD|CNY|RMB|EUR|GBP|[$€¥£])", headers[loc["price"]], re.IGNORECASE
        )
        currencies = [
            x
            for x in [
                get("currency"),
                match and (match[1] or match[3]),
                denom and denom[1],
            ]
            if x
        ]
        currency = currencies[0] if currencies else ""
        fields = {
            "型号或品名": item,
            "参考价格": match[2].replace(",", "") if match else "",
            "单位": get("unit"),
            "币种": currency,
        }
        currency_names = {x.upper() for x in currencies}
        dollars = currency_names - {"$"}
        compatible_dollar = (
            "$" in currency_names
            and len(dollars) == 1
            and dollars.issubset({"USD", "CAD", "AUD", "HKD"})
        )
        if len(currency_names) > 1 and not compatible_dollar:
            fields["参考价格"] = ""
            self.warnings.append(f"{source} · 币种有冲突，请核对原件。")
        if group:
            fields["系列"] = group
        for i, (h, v) in enumerate(zip(headers, values)):
            if (
                role(h) in {"model", "photo", "price", "unit", "currency", "source"}
                or not clean(v)
                or not h
            ):
                continue
            if role(h) == "name" and clean(v) == item:
                continue
            lines = str(v).strip().splitlines()
            if clean(h) == "规格" and lines and all("：" in line for line in lines):
                parts = [line.split("：", 1) for line in lines]
                if all(
                    k
                    and not role(k)
                    in {"model", "photo", "price", "unit", "currency", "source"}
                    and k not in fields
                    for k, _ in parts
                ) and len({k for k, _ in parts}) == len(parts):
                    fields.update((k, clean(value)) for k, value in parts)
                    continue
            fields[clean(h)] = clean(v)
        fields["来源"] = get("source") or source
        row = {"sheet": sheet, "number": number, "fields": fields, "images": []}
        self.rows.append(row)
        if len(self.rows) > 3000:
            raise ValueError("单份图文清单最多 3000 行，请分册导入")
        return row

    def photo(self, row, origin, make, detail=False):
        try:
            data = make()
        except (ValueError, OSError, KeyError):
            self.warnings.append(origin + " · 图片无法读取，可人工补图。")
            return
        self.image_bytes += len(data)
        if self.image_bytes > 32 * 1024**2:
            raise ValueError("配图总量过大，请分册导入")
        row["images"].append({"origin": origin, "data": data, "detail": detail})

    def result(self):
        if not self.rows:
            raise ValueError(
                "未找到含型号或品名及单一对客单价的表格。可整理成带表头、每行一款的 Word、Excel 或 Markdown 后导入。"
            )
        counts = Counter(
            (r["sheet"], r["fields"]["型号或品名"].casefold()) for r in self.rows
        )
        for r in self.rows:
            if (
                counts[r["sheet"], r["fields"]["型号或品名"].casefold()] > 1
                and r["images"]
            ):
                self.warnings.append(
                    f"{r['fields']['来源']} · 型号重复，配图归属待核对。"
                )
                r["images"] = []
        return {
            "rows": self.rows,
            "figures": self.figures,
            "terms": list(dict.fromkeys(self.terms)),
            "warnings": list(dict.fromkeys(self.warnings)),
            "pageCount": self.page_count,
        }


def pdf_catalog(data, cat):
    import pdfplumber

    with pdfplumber.open(data) as doc:
        cat.page_count = len(doc.pages)
        if cat.page_count > 100:
            raise ValueError("单份报价 PDF 最多 100 页，请分册导入")
        for n, page in enumerate(doc.pages, 1):
            start = len(cat.rows)
            rendered = None

            def page_picture(box, page=page):
                nonlocal rendered
                if rendered is None:
                    dpi = min(192, 72 * (5_500_000 / (page.width * page.height)) ** 0.5)
                    rendered = page.to_image(resolution=dpi)
                pixels = tuple(
                    round((v - base) * rendered.scale)
                    for v, base in zip(box, rendered.bbox[:2] * 2)
                )
                return thumbnail(rendered.original.crop(pixels))

            for tno, table in enumerate(page.find_tables(), 1):
                headers, loc, group = [], None, ""
                values = table.extract()
                used = []
                for i, (cells, row) in enumerate(zip(values, table.rows)):
                    first = clean(cells[0])
                    found = layout(cells)
                    if found:
                        headers, loc = [clean(v) for v in cells], found
                        continue
                    if ambiguous_header(cells):
                        loc = None
                        cat.warnings.append(
                            f"PDF p.{n} · 表 {tno} 行 {i + 1} 报价列需人工确认。"
                        )
                        continue
                    if (
                        loc
                        and used
                        and re.match(
                            r"^(?:remarks?|notes?|报价条件)\s*[:：]?$",
                            first.split("\n")[0],
                            re.IGNORECASE,
                        )
                    ):
                        footer = page.crop(
                            (table.bbox[0], row.bbox[1], table.bbox[2], table.bbox[3])
                        ).extract_text(x_tolerance=1)
                        if footer:
                            cat.terms.append(footer.strip())
                        break
                    if (
                        loc
                        and used
                        and first
                        and (
                            re.search(r"deposit|定金", first, re.IGNORECASE)
                            or first.startswith("Remarks ")
                        )
                    ):
                        cat.terms.append(" ".join(clean(s) for s in cells if clean(s)))
                        continue
                    if first and sum(bool(clean(v)) for v in cells) == 1:
                        if not group.startswith(first):
                            group = first
                        # A series illustration occupies its title row, outside all product rows.
                        if any(layout(future) for future in values[i + 1 : i + 4]):
                            for img in page.images:
                                box = tuple(
                                    img[k] for k in ("x0", "top", "x1", "bottom")
                                )
                                if (
                                    box[1] >= row.bbox[1] - 1
                                    and box[3] <= row.bbox[3] + 1
                                ):
                                    source = f"PDF p.{n} · 表 {tno} 行 {i + 1}"
                                    figure = {
                                        "label": group,
                                        "source": source,
                                        "images": [],
                                    }
                                    cat.photo(
                                        figure,
                                        source + " · 系列标题行",
                                        lambda box=box: page_picture(box),
                                    )
                                    if figure["images"]:
                                        cat.figures.append(figure)
                        continue
                    if not loc:
                        continue
                    # Contract prose crossing grid lines is not a product row.
                    # A blank amount is valid only for an identifiable item row.
                    if (
                        first
                        and not re.fullmatch(r"\d+[.)]?", first)
                        and loc.get("model", 0) != 0
                        and loc.get("name", 0) != 0
                    ):
                        continue
                    idcol = loc.get("model", loc.get("name"))
                    raw_price = clean(cells[loc["price"]])
                    if not clean(cells[idcol]) or (
                        not raw_price
                        and not re.fullmatch(r"[\w.-]*\d[\w.-]*", clean(cells[idcol]))
                    ):
                        continue
                    source = f"PDF p.{n} · 表 {tno} 行 {i + 1}"
                    record = cat.row(
                        headers,
                        loc,
                        cells,
                        f"PDF p.{n}" + (f" · 表 {tno}" if tno > 1 else ""),
                        i + 1,
                        source,
                        group,
                    )
                    if record is None:
                        continue
                    used.append(i)
                    photo_col = loc.get("photo")
                    image_cells = [
                        (c, j != photo_col)
                        for j, c in enumerate(row.cells)
                        if c
                        and (
                            j == photo_col
                            or key(headers[j])
                            in {"remark", "remarks", "备注", "安装图", "示意图"}
                        )
                    ]
                    for img in page.images:
                        x, y, r, b = (img[k] for k in ("x0", "top", "x1", "bottom"))
                        match = next(
                            (
                                (cell, detail)
                                for cell, detail in image_cells
                                if cell[0] <= (x + r) / 2 <= cell[2]
                                and cell[1] <= (y + b) / 2 <= cell[3]
                            ),
                            None,
                        )
                        if not match:
                            continue
                        cell, detail = match
                        if (
                            min(x - cell[0], y - cell[1], cell[2] - r, cell[3] - b)
                            < -1.5
                            or r - x < 2
                            or b - y < 2
                        ):
                            cat.warnings.append(source + " · 图片跨格，配图待核对。")
                            continue
                        cat.photo(
                            record,
                            source
                            + f" · {headers[loc['photo']] if not detail else '备注'}裁图 ({x:.0f},{y:.0f},{r:.0f},{b:.0f})",
                            lambda box=(x, y, r, b): page_picture(box),
                            detail,
                        )
            if len(cat.rows) == start:
                cat.warnings.append(
                    f"PDF p.{n} · "
                    + (
                        "扫描页，需对照原页。"
                        if not page.chars
                        else "未识别为单一对客报价表，保留在原件中。"
                    )
                )
            page.close()


FIGURE_HEADERS = ["系列", "系列参考图", "来源"]


def read_cell(cat, headers, loc, cells, sheet, number, source):
    if headers == FIGURE_HEADERS:
        fig = {
            "label": clean(cells[0]),
            "source": clean(cells[2]) or source,
            "images": [],
        }
        cat.figures.append(fig)
        return fig, 1
    return cat.row(headers, loc, cells, sheet, number, source), loc.get("photo")


def word_catalog(data, cat):
    from docx import Document

    doc = Document(data)
    for p in doc.paragraphs:
        if p.text.startswith("报价条件 · "):
            cat.terms.append(p.text.removeprefix("报价条件 · ").strip())
    for i, table in enumerate(doc.tables, 1):
        rows = iter(table.rows)
        head = next(rows, None)
        headers = [clean(c.text) for c in head.cells] if head is not None else []
        loc = layout(headers)
        if not loc and headers != FIGURE_HEADERS:
            cat.warnings.append(f"Word 表 {i} · 未识别为单一对客报价表。")
            continue
        for n, row in enumerate(rows, 2):
            cells = row.cells
            if len(cells) != len(headers) or any(
                tc.xpath("./w:tcPr/w:vMerge|./w:tcPr/w:gridSpan")
                for tc in row._tr.tc_lst
            ):
                cat.warnings.append(f"Word 表 {i} 行 {n} · 合并格需人工核对。")
                continue
            source = f"Word 表 {i} 行 {n}"
            item, col = read_cell(
                cat, headers, loc, [c.text for c in cells], f"表 {i}", n, source
            )
            if item and col is not None:
                if cells[col]._tc.xpath(".//wp:anchor"):
                    cat.warnings.append(source + " · 浮动图片需要核对归属。")
                for inline in cells[col]._tc.xpath(".//wp:inline"):
                    blips = inline.xpath(".//a:blip")
                    if len(blips) != 1:
                        continue
                    blip = blips[0]
                    rid = blip.get(
                        "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed"
                    )
                    rel = doc.part.rels.get(rid)
                    if rel and not rel.is_external and rel.reltype.endswith("/image"):
                        cat.photo(
                            item,
                            source + " · 同格嵌图",
                            lambda rel=rel: picture(rel.target_part.blob),
                            inline.docPr.get("descr") == "备注图",
                        )


def excel_catalog(data, cat):
    from openpyxl import load_workbook

    book = load_workbook(data, data_only=True, keep_links=False)
    for sheet in book.worksheets:
        if sheet.sheet_state != "visible":
            continue
        if sheet.max_row > 20000 or sheet.max_column > 150:
            raise ValueError("工作表超出 20000 行或 150 列")
        loc, assigned = None, {}
        for n, values in enumerate(sheet.values, 1):
            if sheet.row_dimensions[n].hidden:
                continue
            found = layout(values)
            if found:
                loc, headers = found, [clean(v) for v in values]
                header_number = n
            elif ambiguous_header(values):
                loc = None
                cat.warnings.append(f"{sheet.title} · 行 {n} 报价列需人工确认。")
            elif loc and any(v is not None for v in values):
                model = loc.get("model")
                if model is not None:
                    cell = sheet.cell(n, model + 1)
                    if isinstance(cell.value, int) and re.fullmatch(
                        r"0{2,20}", cell.number_format
                    ):
                        values = list(values)
                        values[model] = str(cell.value).zfill(len(cell.number_format))
                record = cat.row(
                    headers, loc, values, sheet.title, n, f"{sheet.title} · 行 {n}"
                )
                if record:
                    columns = {
                        h: i for i, h in enumerate(headers) if h in record["fields"]
                    }
                    for field, kind in [
                        ("型号或品名", "model" if "model" in loc else "name"),
                        ("参考价格", "price"),
                        ("币种", "currency"),
                        ("单位", "unit"),
                    ]:
                        if kind in loc:
                            columns[field] = loc[kind]
                    if "model" not in loc and record["fields"]["型号或品名"] != clean(
                        values[loc["name"]]
                    ):
                        columns.pop("型号或品名", None)
                    record["columns"] = columns
                    record["width"] = len(headers)
                    if "currency" not in loc and record["fields"]["币种"]:
                        in_value = (
                            record["fields"]["币种"].casefold()
                            in clean(values[loc["price"]]).casefold()
                        )
                        record["sourceRefs"] = {
                            "币种": sheet.cell(
                                n if in_value else header_number, loc["price"] + 1
                            ).coordinate
                        }
                if record and "photo" in loc:
                    assigned[n - 1, loc["photo"]] = record
        sheet_photos(sheet, assigned, cat)
    book.close()


def sheet_photos(sheet, assigned, cat):
    for image in sheet._images:
        a = image.anchor
        start = getattr(a, "_from", None)
        end = getattr(a, "to", None)
        if not start:
            continue
        row = assigned.get((start.row, start.col))
        height = (
            sheet.row_dimensions[start.row + 1].height
            or sheet.sheet_format.defaultRowHeight
            or 15
        )
        fits = (
            end
            and (
                end.row == start.row or end.row == start.row + 1 and end.rowOff == 0
            )
            and (
                end.col == start.col or end.col == start.col + 1 and end.colOff == 0
            )
        )
        if end is None and getattr(a, "ext", None):
            from openpyxl.utils import get_column_letter

            letter = get_column_letter(start.col + 1)
            dimension = sheet.column_dimensions.get(letter)
            width = (
                dimension.width
                if dimension and dimension.width
                else sheet.sheet_format.defaultColWidth or 8.43
            )
            fits = (
                start.rowOff + a.ext.cy <= (height + 1) * 12700
                and start.colOff + a.ext.cx <= (7 * width + 6) * 9525
            )
        if (
            sheet.cell(start.row + 1, start.col + 1).coordinate
            in sheet.merged_cells
        ):
            fits = False
        if row and fits:
            cat.photo(
                row,
                f"{sheet.title} · 行 {start.row + 1} 同格嵌图",
                lambda image=image: picture(image._data()),
            )
        elif row:
            cat.warnings.append(
                f"{sheet.title} · 行 {start.row + 1} 图片跨行，请核对。"
            )


def markdown_catalog(data, cat):
    lines = data.read().decode("utf-8-sig").splitlines()
    headers, loc, table, fence = [], None, 0, ""
    for i, line in enumerate(lines):
        line = line.strip()
        marker = re.match(r"^(`{3,}|~{3,})", line)
        if marker:
            if not fence:
                fence = marker[1]
            elif marker[1].startswith(fence):
                fence = ""
            continue
        if fence:
            continue
        if line.startswith("> 报价条件 · "):
            cat.terms.append(line.removeprefix("> 报价条件 · ").replace("<br>", "\n"))
        if not line.startswith("|"):
            loc = None
            headers = []
            continue
        body = (
            line[1:-1] if line.endswith("|") and not line.endswith(r"\|") else line[1:]
        )
        cells = [
            v.strip().replace(r"\|", "|").replace("<br>", "\n")
            for v in re.split(r"(?<!\\)\|", body)
        ]
        if (
            i + 1 < len(lines)
            and re.fullmatch(r"[\s|:\-]+", lines[i + 1])
            and "-" in lines[i + 1]
        ):
            headers, loc, table = cells, layout(cells), table + 1
            continue
        if (not loc and headers != FIGURE_HEADERS) or all(
            re.fullmatch(r":?-+:?", s) for s in cells
        ):
            continue
        if len(cells) != len(headers):
            cat.warnings.append(f"Markdown 行 {i + 1} · 列数与表头不一致。")
            continue
        source = f"Markdown 行 {i + 1}"
        record, col = read_cell(cat, headers, loc, cells, f"表 {table}", i + 1, source)
        if record and col is not None and cells[col]:
            pattern = r"!\[([^\]]*)\]\(data:image/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)\)"
            cell = cells[col]
            for image in re.finditer(pattern, cell, re.IGNORECASE):
                cat.photo(
                    record,
                    source + " · 同行嵌图",
                    lambda encoded=image[2]: picture(
                        base64.b64decode(encoded, validate=True)
                    ),
                    image[1] == "备注图",
                )
            if re.sub(pattern, "", cell, flags=re.IGNORECASE).strip():
                cat.warnings.append(
                    source + " · 图片未内嵌，请在产品图片中核对或补图。"
                )


def read_catalog(data, kind):
    cat = Catalog()
    readers = {
        "pdf": pdf_catalog,
        "docx": word_catalog,
        "xlsx": excel_catalog,
        "md": markdown_catalog,
    }
    readers[kind](data, cat)
    return cat.result()


def parse_quote(source, kind):
    try:
        return read_catalog(io.BytesIO(source), kind)
    except ImportError as e:
        return {"error": f"本机报价解析环境缺少 {e.name}，请安装文档解析依赖。"}
    except (ValueError, OSError) as e:
        return {"error": str(e)[:500]}
