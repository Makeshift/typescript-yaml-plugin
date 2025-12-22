import OpenApiParser from '@apidevtools/swagger-parser'
import deasync from 'deasync'
import fs from 'node:fs'
import path from 'node:path'
import type { OpenAPI } from 'openapi-types'
import type ts from 'typescript/lib/tsserverlibrary'
import YAML from 'yaml'

const dereferenceSync = deasync<
  OpenAPI.Document | string,
  OpenAPI.Document
>((api, callback) => {
  OpenApiParser.dereference(api, (err, doc) => {
    callback(err, doc!)
  })
})

const getStringAttribute = (ts_: typeof ts, node: ts.Node, attributeName: string): string | undefined => {
  const importDecl = ts_.isImportDeclaration(node.parent) ? node.parent : node.parent?.parent
  if (!importDecl || !ts_.isImportDeclaration(importDecl)) return undefined
  const attributes = importDecl.attributes?.elements
  if (!attributes) return undefined
  const attribute = attributes.find(attr => attr.name.text === attributeName)
  if (!attribute) return undefined
  return ts_.isStringLiteral(attribute.value) ? attribute.value.text : undefined
}

const hasStringAttribute = (ts_: typeof ts, node: ts.Node, attributeName: string, attributeValue?: string): boolean => {
  const value = getStringAttribute(ts_, node, attributeName)
  if (attributeValue) {
    return value === attributeValue
  }
  return !!value
}

const parseAsOpenAPIDocument = (content: object, version: string) => {
  // getScriptSnapshot expects a synchronous function, so we have to wrap the async OpenApiParser calls
  try {
    return dereferenceSync(content as OpenAPI.Document)
  } catch (error) {
    throw new Error(`[typescript-plugin-yaml] OpenAPI parse error:\n${error as string}`)
  }
}

export = ({ typescript: ts_ }: { typescript: typeof ts }) => ({
  create: (info: ts.server.PluginCreateInfo) => {
    const { logger } = info.project.projectService
    const { languageServiceHost, languageService } = info
    const constImports = new Set<string>()
    let openAPIVersion: string | undefined

    const getScriptKind = languageServiceHost.getScriptKind?.bind(languageServiceHost)
    languageServiceHost.getScriptKind = fileName => {
      if (!getScriptKind) return ts_.ScriptKind.Unknown
      if (/\.ya?ml$/.test(fileName)) return ts_.ScriptKind.TS
      return getScriptKind(fileName)
    }
    const fileExists = languageServiceHost.fileExists.bind(languageServiceHost)
    const getScriptSnapshot
      = languageServiceHost.getScriptSnapshot.bind(languageServiceHost)
    languageServiceHost.getScriptSnapshot = fileName => {
      if (!/\.ya?ml$/.test(fileName)) return getScriptSnapshot(fileName)
      if (!fileExists(fileName)) return
      const content = fs.readFileSync(fileName, 'utf8')
      let object
      let text = ''
      let asConst = ''
      try {
        object = YAML.parse(content)
      } catch (error) {
        logger.info(`[typescript-plugin-yaml] YAML.parse error:\n${error as string}`)
      }

      if (constImports.has(fileName)) {
        asConst = 'as const'
      }
      
      if (openAPIVersion) {
        const parsedDoc = parseAsOpenAPIDocument(object, openAPIVersion)
        text = `import type { OpenAPI } from 'openapi-types'
const parsed = ${JSON.stringify(parsedDoc)} ${asConst}
export default parsed`
        // This overrode the asConst :/
        // if (openAPIVersion) {
        //   text += ' satisfies OpenAPI.OpenAPIV' + openAPIVersion.replace('.', '_')
        // } else {
        //   text += ' satisfies OpenAPI.Document'
        // }
      } else {
        text = `export default ${JSON.stringify(object)} ${asConst}`
      }

      return ts_.ScriptSnapshot.fromString(text)
    }
    const resolveModuleNameLiterals
      = languageServiceHost.resolveModuleNameLiterals!.bind(languageServiceHost)
    languageServiceHost.resolveModuleNameLiterals = (
      moduleLiterals,
      containingFile,
      ...rest
    ) =>
      resolveModuleNameLiterals(moduleLiterals, containingFile, ...rest).map(
        (resolvedModule, index) => {
          const moduleLiteral = moduleLiterals[index]
          const moduleName = moduleLiteral.text
          if (!/\.ya?ml$/.test(moduleName)) return resolvedModule
          const resolvedFileName = resolvedModule.failedLookupLocations[1].slice(0, -3)
          if (hasStringAttribute(ts_, moduleLiteral, 'const', 'true')) {
            constImports.add(resolvedFileName)
          }
          if (hasStringAttribute(ts_, moduleLiteral, 'openAPI', 'true') || hasStringAttribute(ts_, moduleLiteral, 'openAPIVersion')) {
            openAPIVersion = getStringAttribute(ts_, moduleLiteral, 'openAPIVersion') ?? '3.1.0'
          }
          return {
            ...resolvedModule,
            resolvedModule: {
              extension: ts_.Extension.Ts,
              isExternalLibraryImport: false,
              resolvedFileName,
            },
          }
        },
      )

    const languageServiceOverride = {
      getCompletionsAtPosition(fileName, position, options, formattingSettings) {
        const completions = languageService.getCompletionsAtPosition(
          fileName,
          position,
          options,
          formattingSettings,
        )
        if (!completions) return completions
        const sourceFile = info.languageService.getProgram()?.getSourceFile(fileName)
        if (!sourceFile) return completions
        const token = ts_.getTokenAtPosition(sourceFile, position)
        if (!ts_.isModuleSpecifierLike(token)) return completions
        const [{ failedLookupLocations }] = resolveModuleNameLiterals(
          [token as ts.StringLiteralLike],
          fileName,
          undefined,
          info.project.getCompilerOptions(),
          sourceFile,
          undefined,
        )
        fs.globSync(`${path.dirname(failedLookupLocations[0])}/*.{yaml,yml}`)
          .map(fileName => path.basename(fileName))
          .forEach(baseFileName =>
            completions.entries.push({
              name: baseFileName,
              kind: ts_.ScriptElementKind.scriptElement,
              kindModifiers: '.yaml',
              sortText: '11',
            }),
          )
        return completions
      },
    } as Partial<ts.LanguageService>
    const languageServiceProxy = new Proxy(languageService, {
      get: (target, key: keyof ts.LanguageService) =>
        languageServiceOverride[key] ?? target[key],
    })
    return languageServiceProxy
  },
})
