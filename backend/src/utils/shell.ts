export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function quoteArgs(args: string[]): string {
  return args.map(shellEscape).join(" ");
}
