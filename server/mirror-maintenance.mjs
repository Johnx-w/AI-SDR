// A whole record may finish; the next record or read-only page must yield.
export function checkMirrorMaintenance(isMaintaining) {
  if (isMaintaining())
    throw Object.assign(new Error('发布维护中，镜像稍后继续同步'), {
      status: 503,
      maintenance: true,
    });
}
