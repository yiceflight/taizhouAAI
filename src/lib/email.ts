export type EmailSettings = { recipients: string[]; username: string; configured: boolean };

export function mergeRecipients(current: string[], draft: string): string[] {
  const result = [...current];
  for (const address of draft.split(/[\s,;，；]+/).filter(Boolean)) {
    if (address.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) {
      throw new Error(`邮箱地址无效：${address}`);
    }
    if (!result.some(existing => existing.toLowerCase() === address.toLowerCase())) result.push(address);
  }
  return result;
}
