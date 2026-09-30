import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultNetworkBrandsPaths, syncNetworkBrands } from './sync-network-brands.ts'

const tempDirs: string[] = []

function makeTempDir(): string {
  mkdirSync(resolve(process.cwd(), 'tmp'), { recursive: true })
  const dir = mkdtempSync(resolve(process.cwd(), 'tmp/sync-network-brands-'))
  tempDirs.push(dir)
  return dir
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value)}\n`)
}

afterEach(() => {
  tempDirs.splice(0).forEach(dir => {
    rmSync(dir, { force: true, recursive: true })
  })
})

describe('syncNetworkBrands', () => {
  it('copies validated source JSON to the runtime target', () => {
    const tempDir = makeTempDir()
    const sourcePath = resolve(tempDir, 'source/network-brands.json')
    const targetPath = resolve(tempDir, 'target/network-brands.json')

    writeJsonFile(sourcePath, {
      brandGroups: {
        example: ['alpha']
      },
      brands: {
        alpha: { name: 'Alpha', url: 'https://alpha.example' }
      }
    })

    const result = syncNetworkBrands({ sourcePath, targetPath })

    expect(result).toEqual({
      brandCount: 1,
      sourcePath,
      targetPath
    })
    expect(JSON.parse(readFileSync(targetPath, 'utf8'))).toEqual({
      brandGroups: {
        example: ['alpha']
      },
      brands: {
        alpha: { name: 'Alpha', url: 'https://alpha.example' }
      }
    })
    expect(readFileSync(targetPath, 'utf8')).toContain('\n')
  })

  it('rejects JSON without a brands object and leaves target untouched', () => {
    const tempDir = makeTempDir()
    const sourcePath = resolve(tempDir, 'source/network-brands.json')
    const targetPath = resolve(tempDir, 'target/network-brands.json')

    writeJsonFile(sourcePath, { items: [] })

    expect(() => syncNetworkBrands({ sourcePath, targetPath })).toThrow(
      `Network brands source "${sourcePath}" must contain a brands object`
    )
    expect(existsSync(targetPath)).toBe(false)
  })

  it('rejects non-https brand URLs and leaves target untouched', () => {
    const tempDir = makeTempDir()
    const sourcePath = resolve(tempDir, 'source/network-brands.json')
    const targetPath = resolve(tempDir, 'target/network-brands.json')

    writeJsonFile(sourcePath, {
      brands: {
        alpha: { name: 'Alpha', url: 'http://alpha.example' }
      }
    })

    expect(() => syncNetworkBrands({ sourcePath, targetPath })).toThrow(
      'Brand url must use https: http://alpha.example'
    )
    expect(existsSync(targetPath)).toBe(false)
  })

  it('rejects duplicate normalized brand URLs and leaves target untouched', () => {
    const tempDir = makeTempDir()
    const sourcePath = resolve(tempDir, 'source/network-brands.json')
    const targetPath = resolve(tempDir, 'target/network-brands.json')

    writeJsonFile(sourcePath, {
      brands: {
        alpha: { name: 'Alpha', url: 'https://alpha.example' },
        alphaDuplicate: { name: 'Alpha Duplicate', url: 'https://ALPHA.example/' }
      }
    })

    expect(() => syncNetworkBrands({ sourcePath, targetPath })).toThrow(
      'Duplicate brand url detected for alphaDuplicate and alpha: https://alpha.example'
    )
    expect(existsSync(targetPath)).toBe(false)
  })

  it('rejects brand groups that reference missing brand slugs and leaves target untouched', () => {
    const tempDir = makeTempDir()
    const sourcePath = resolve(tempDir, 'source/network-brands.json')
    const targetPath = resolve(tempDir, 'target/network-brands.json')

    writeJsonFile(sourcePath, {
      brandGroups: {
        example: ['alpha', 'missing']
      },
      brands: {
        alpha: { name: 'Alpha', url: 'https://alpha.example' }
      }
    })

    expect(() => syncNetworkBrands({ sourcePath, targetPath })).toThrow(
      'Brand group example references unknown brand slug: missing'
    )
    expect(existsSync(targetPath)).toBe(false)
  })

  it('defaults to the SERP docs source and web-core runtime target', () => {
    const paths = getDefaultNetworkBrandsPaths({
      homeDir: '/Users/example',
      repoRoot: '/workspace/directory-platform-d1'
    })

    expect(paths).toEqual({
      sourcePath: '/Users/example/dev/repos/serp/docs/websites/pages/brands.json',
      targetPath: '/workspace/directory-platform-d1/packages/web-core/src/data/network-brands.json'
    })
  })
})
