export const pagedMaterialTypes = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export const isPagedMaterial = (type) => Object.values(pagedMaterialTypes).includes(type);
export const documentLimitMiB = 50;
export const videoLimitMiB = 80;
export const materialPartBytes = 8 * 1024 ** 2;
export const videoTypes = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };

export function checkMaterialSize(name, bytes) {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const video = Object.hasOwn(videoTypes, extension);
  const limit = video ? videoLimitMiB : documentLimitMiB;
  if (bytes > limit * 1024 ** 2)
    throw Object.assign(new Error(`单个${video ? '视频' : '资料文件'}不能超过 ${limit} MiB`), {
      status: 413,
    });
}
