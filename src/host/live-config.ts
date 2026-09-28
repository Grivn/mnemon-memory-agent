import { isVolatile, type Volatile } from '@deepseek-ai/cosmokit'
import type z from 'schemastery'
import ProfileSchema from './profile-schema.mjs'
import { Config as PlainConfig, resolveConfig, type Config } from './config.ts'

/** DSH keeps these references stable while committing live profile edits. */
export type LiveHostConfig = {
  [Key in keyof Config]-?: Key extends 'remoteAccess' ? Config[Key] : Volatile<Config[Key]>
}

function plain(value: unknown): unknown {
  if (isVolatile(value)) return plain(value.get())
  if (Array.isArray(value)) return value.map(plain)
  if (value === null || typeof value !== 'object') return value
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]))
}

/** Read a detached configuration snapshot from either DSH generation. */
export function plainHostConfig(value: unknown = {}): Config {
  return plain(value) as Config
}

function liveConfig(): z<Config, LiveHostConfig> {
  // Rehydrate the published schema into the fork that creates real Volatile
  // references; adding metadata to the old parser would silently skip updates.
  const schema = new ProfileSchema(PlainConfig.toJSON())
  schema.dict = Object.fromEntries(Object.entries(schema.dict ?? {}).map(([key, field]) => [
    key, key === 'remoteAccess' ? field : field.volatile(),
  ]))
  const standard = schema['~standard']
  Object.defineProperty(schema, '~standard', {
    value: {
      ...standard,
      validate(value: unknown) {
        const parsed = standard.validate(value)
        if ('then' in parsed) throw new TypeError('Mnemon configuration validation must be synchronous')
        if (parsed.issues) return parsed
        try {
          // Keep the object schema visible to SettingsForms while enforcing
          // pure cross-field constraints before ConfigEditor persists a write.
          resolveConfig(plainHostConfig(parsed.value))
          return parsed
        } catch (error) {
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
        }
      },
    },
  })
  return schema as unknown as z<Config, LiveHostConfig>
}

/** Profile Config for live forms; transport authority retains normal remounts. */
export const LiveConfig = liveConfig()
