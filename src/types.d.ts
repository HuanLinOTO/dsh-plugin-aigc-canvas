/**
 * types.d.ts — minimal ambient declarations for the peer dependencies this
 * plugin consumes (private @deepseek-ai/* packages and `cordis`, all provided
 * by the DSH host at runtime). Only the slices `src/*` actually touches are
 * restated here so standalone typecheck works without a DSH source checkout.
 *
 * Authoritative definitions live in DSH staging `packages/core/tools/src/schema.ts`
 * and `vendor/cordis`; this file mirrors their shapes, not the full surface.
 */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '@deepseek-ai/dsh-tools' {
  export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

  export type ContentBlock = { type: 'text'; text: string }

  export interface ValueSchemaAnnotations {
    description?: string
    title?: string
    default?: JsonValue
    examples?: JsonValue
  }

  export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'string'
    enum?: readonly string[]
    const?: string
  }

  export interface NumberValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'number' | 'integer'
    enum?: readonly number[]
    const?: number
  }

  export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'boolean'
  }

  export interface NullValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'null'
  }

  export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'array'
    items?: ValueSchemaSpec
  }

  export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'object'
    properties?: ParameterSchemaSpec
    additionalProperties: boolean
  }

  export interface JsonValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'json'
  }

  export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations {
    oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]]
  }

  export type ValueSchemaSpec =
    | StringValueSchemaSpec
    | NumberValueSchemaSpec
    | BooleanValueSchemaSpec
    | NullValueSchemaSpec
    | ArrayValueSchemaSpec
    | ObjectValueSchemaSpec
    | JsonValueSchemaSpec
    | OneOfValueSchemaSpec

  export type ParameterPropertySpec = ValueSchemaSpec & { required?: true }

  export type ParameterSchemaSpec = {
    [key: string]: ParameterPropertySpec
    [key: symbol]: never
  }

  type InferObject<S> =
    S extends { properties: infer P }
      ? S extends { additionalProperties: true }
        ? InferProps<P> & Record<string, JsonValue>
        : InferProps<P>
      : S extends { additionalProperties: true }
        ? Record<string, JsonValue>
        : Record<string, never>

  type InferProps<S> = S extends undefined
    ? Record<string, never>
    : {
        [K in Extract<keyof S, string> as S[K] extends { required: true } ? K : never]: InferValueAt<S[K]>
      } & {
        [K in Extract<keyof S, string> as S[K] extends { required: true } ? never : K]?: InferValueAt<S[K]>
      }

  type InferValueAt<S> =
    S extends { type: 'string' } ? string :
      S extends { type: 'number' | 'integer' } ? number :
        S extends { type: 'boolean' } ? boolean :
          S extends { type: 'null' } ? null :
            S extends { type: 'array' }
              ? S extends { items: infer I } ? InferValueAt<I>[] : JsonValue[]
              : S extends { type: 'object' } ? InferObject<S> :
                S extends { type: 'json' } ? JsonValue :
                  S extends { oneOf: readonly unknown[] } ? InferValueAt<S['oneOf'][number]> :
                    never

  export type InferArgs<S> = InferProps<S>

  export type InferValue<S> = InferValueAt<S>

  /** The agent face seen on `exec.agent`. */
  export interface Agent {
    readonly id: string
    readonly session: {
      readonly id: string
      readonly header: { readonly cwd?: string }
    }
  }

  export interface ToolRunContext {
    readonly signal: AbortSignal
    readonly callId: string
    readonly name: string
    readonly arguments: unknown
    readonly agent?: Agent
  }

  export interface DefineToolOptions {
    readonly name: string
    readonly description: string
    readonly parameters: ParameterSchemaSpec
    readonly output: {
      readonly schema: ValueSchemaSpec
      render(args: unknown, value: unknown): ContentBlock[]
    }
    readonly timeoutMs?: number
    execute(args: unknown, exec: ToolRunContext): Promise<unknown> | unknown
  }

  export function defineTool(options: DefineToolOptions): unknown
}

declare module 'cordis' {
  export interface Context {
    tools: {
      register(definition: unknown): () => void
      schemas(): readonly { name: string; description: string }[]
    }
    webServer: {
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
      }): () => void
      registerUpgrade(route: {
        path: string
        handler: (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => void | Promise<void>
      }): () => void
    }
    sessions: {
      get(id: string): { header: { cwd?: string } } | undefined
    }
    agents: {
      get(id: string): {
        readonly id: string
        inject(message: {
          readonly id: string
          readonly role: 'user'
          readonly content: ReadonlyArray<{ type: 'text'; text: string }>
          readonly source: {
            readonly kind: 'plugin'
            readonly plugin: string
            readonly form?: 'notice' | 'progress'
            readonly summary?: string
          }
        }): void
      } | undefined
    }
    loader: {
      entries(): Iterable<{ options: { name: string; config?: unknown } }>
    }
    invariants: {
      register(
        packageName: string,
        installer: (ctx: Context, fail: (message: string) => never) => void | Promise<void>,
      ): () => void
    }
    get(name: string): unknown
    /** Publish a service value onto the context (DSH-vendored cordis). */
    provide(name: string, value: unknown): void
    effect(fn: () => void | (() => void), label?: string): void
    on(event: string, listener: (...args: unknown[]) => unknown): () => void
    inject(services: readonly string[], callback: (ctx: Context) => void): void
    readonly logger: {
      info(...args: unknown[]): void
      warn(...args: unknown[]): void
      error(...args: unknown[]): void
      debug(...args: unknown[]): void
    }
  }
}
