# 报价行配图的定位与复核

## 公开项目如何保存图片位置

- **Docling** 给图和表保留来源页码、边界框和图注引用。表格单元格另有起止行列、跨行数和可选的边界框。`get_image()` 优先使用已有的元素图。如果需要从整页预览裁图，它先把边界框换算到左上原点，再按预览尺寸缩放后裁剪。 [文档数据结构](https://docling-project.github.io/docling/reference/docling_document/#docling_core.types.doc.ProvenanceItem) · [裁图实现](https://github.com/docling-project/docling-core/blob/f347b36bb6203ebdeb9decad56dd2bf14c9e061f/docling_core/types/doc/items/node.py#L171-L233)
- **Azure Document Intelligence Layout v4** 用 `boundingRegions` 记录图所在的页和多边形，用 `elements` 指向相关文字，并单独返回图注。表格单元格有行列索引和占用范围。选择 `output=figures` 可取得检测到的图的裁图。裁图范围只含图主体，图注和脚注可从结构化结果另读。 [图与段落的关联](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/concept/analyze-document-response?view=doc-intel-4.0.0#figures) · [裁图范围](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/prebuilt/layout?view=doc-intel-4.0.0#figures) · [表格单元格字段](https://learn.microsoft.com/en-us/python/api/azure-ai-documentintelligence/azure.ai.documentintelligence.models.documenttablecell?view=azure-python#azure-ai-documentintelligence-models-documenttablecell-row-span)
- **PyMuPDF** 的 `extract_image()` 按 PDF 对象引用提取内嵌图片，`get_image_rects()` 给出它在本页每次出现的矩形。`get_pixmap(clip=…)` 则渲染框内可见的版面。对于被整幅图覆盖或缺少文字层的页面，官方示例给出了按页进行 OCR 的条件。 [嵌入图与页面裁图](https://pymupdf.readthedocs.io/en/latest/recipes-images.html) · [图片出现位置](https://pymupdf.readthedocs.io/en/latest/page.html#Page.get_image_rects) · [扫描页 OCR](https://pymupdf.readthedocs.io/en/latest/ocr/index.html#how-to-ocr-a-document-page)

## 本项目的设计建议

本版通过 pdfplumber 的 `find_tables()` 获取物理表格、行和单元格边界，再用同一页的图片出现位置核对归属。确认属于同一行后，按图片在原页的可见范围裁图。PDF、文本、价格和配图均在本机处理。[pdfplumber 表格提取](https://github.com/jsvine/pdfplumber#extracting-tables)

- **让每处配图能回到原页。** 按图片的每次出现记录来源文件、版本、从 1 开始的物理页码和图框。同页的图框和候选行框按同一坐标原点、单位及旋转方向映射到预览。同一张图出现在两处时，两处各自保留所在行与原文。
- **让业务员看得出为何匹配。** 图落在单个产品行，且该行有唯一的完整型号或明确图注时，可以提示对应行并展示文字依据。一幅图跨越多行、页面只有二维码或图片、扫描页经 OCR 仍读不到可核对的型号时，保留原页、图框、可辨认的候选行和待核原因，由业务员确认适用范围。
- **按取得方式标注图片。** 有厂家供图记录的独立图文件可标为「原厂图」。从 PDF 对象取出的是「文档内嵌图」，按页面矩形渲染得到的是「版面截图」。截图可能带价格、邻行或脚注，预览时显示框边及原页上下文，便于决定是否适合作为产品配图。
