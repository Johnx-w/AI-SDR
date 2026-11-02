export function customerGrade(grade, status = '') {
  if (grade === '暂不开发' || status === '暂不开发') return '';
  return ['A', 'B', 'C'].includes(grade) ? grade : 'C';
}
