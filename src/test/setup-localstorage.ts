/**
 * 测试环境垫片：node 环境无 localStorage，用内存 Map 模拟。
 * 在任何模块导入前安装（setupFiles 先于测试文件执行）。
 */
const mem = new Map<string, string>();

const shim = {
  getItem: (key: string): string | null => (mem.has(key) ? mem.get(key)! : null),
  setItem: (key: string, value: string): void => {
    mem.set(key, value);
  },
  removeItem: (key: string): void => {
    mem.delete(key);
  },
  clear: (): void => mem.clear(),
  key: (index: number): string | null => Array.from(mem.keys())[index] ?? null,
  length: mem.size,
};

(globalThis as unknown as { localStorage: Storage }).localStorage = shim as Storage;

export { mem as localStorageMem };
