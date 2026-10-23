/**
 * 智能元数据多值切分工具
 * 兼容中英文所有常用分隔符：
 * - 换行: \r\n, \n
 * - 斜杠: 半角 /、全角 ／、反斜杠 \
 * - 逗号: 半角 ,、全角 ，
 * - 顿号: 、
 * - 分号: 半角 ;、全角 ；
 * - 竖线: |
 */
export function splitMultiValue(input: string | null | undefined): string[] {
  if (!input) return [];
  // 按照换行、中英文斜杠、逗号、顿号、分号、竖线切分
  const parts = input.split(/[\r\n/／\\,，、;；|]+/);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }

  return result;
}

/**
 * 将多值数组格式化为可读字符串（单行用 / 分隔，多行用换行分隔）
 */
export function formatMultiValue(items: string[] | null | undefined, multiline = false): string {
  if (!items || items.length === 0) return '';
  return multiline ? items.join('\n') : items.join(' / ');
}
