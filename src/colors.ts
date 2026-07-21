/**
 * Simple ANSI color helpers for terminal output.
 * No dependencies — just escape codes.
 */

const esc = (code: string) => `\x1b[${code}m`;
const reset = esc('0');

export const colors = {
  bold: (text: string) => `${esc('1')}${text}${reset}`,
  dim: (text: string) => `${esc('2')}${text}${reset}`,
  green: (text: string) => `${esc('32')}${text}${reset}`,
  yellow: (text: string) => `${esc('33')}${text}${reset}`,
  blue: (text: string) => `${esc('34')}${text}${reset}`,
  magenta: (text: string) => `${esc('35')}${text}${reset}`,
  cyan: (text: string) => `${esc('36')}${text}${reset}`,
  red: (text: string) => `${esc('31')}${text}${reset}`,
};

/**
 * Print a styled header block to the console.
 */
export function printHeader(text: string): void {
  const line = '─'.repeat(60);
  console.log(colors.cyan(line));
  console.log(colors.bold(colors.cyan(`  ${text}`)));
  console.log(colors.cyan(line));
}

/**
 * Print a step indicator for tool calls.
 */
export function printStep(step: number, toolName: string, args: Record<string, unknown>): void {
  const argsStr = Object.keys(args).length > 0 ? JSON.stringify(args) : '';
  console.log(
    colors.dim(`  [step ${step}]`) + ' ' +
    colors.magenta(toolName) +
    (argsStr ? colors.dim(`(${argsStr})`) : ''),
  );
}

/**
 * Format the final review output with colors.
 */
export function printReview(review: string): void {
  const lines = review.split('\n');

  for (const line of lines) {
    if (line.startsWith('### ')) {
      console.log('\n' + colors.bold(colors.yellow(line)));
    } else if (line.startsWith('📍')) {
      console.log(colors.red(line));
    } else if (line.includes('**APPROVE**')) {
      console.log(colors.bold(colors.green(line)));
    } else if (line.includes('**REQUEST CHANGES**')) {
      console.log(colors.bold(colors.red(line)));
    } else if (line.includes('**COMMENT**')) {
      console.log(colors.bold(colors.yellow(line)));
    } else {
      console.log(line);
    }
  }
}
