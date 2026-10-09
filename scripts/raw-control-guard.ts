import ts from 'typescript'

/**
 * The scanner behind `raw-control-guard.test.ts` (#188): finds the native form controls a
 * component renders itself, where a stock shadcn component exists for each.
 */

const RAW_CONTROLS = new Set(['button', 'input', 'select', 'textarea'])

/** Every raw `<button>`, `<input>`, `<select>` or `<textarea>` JSX element, as `line: <tag>`. */
export function rawControls(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const found: string[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      RAW_CONTROLS.has(node.tagName.text)
    ) {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
      found.push(`${line + 1}: <${node.tagName.text}>`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}
