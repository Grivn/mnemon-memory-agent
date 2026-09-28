import type Schema from 'schemastery'
import type { Volatile } from '@deepseek-ai/cosmokit'

// The published fork and legacy parser declare different global Schemastery
// generics. Only this private runtime boundary needs the new volatile method.
interface ProfileSchema<S = any, T = S> extends Schema<S, T> {
  dict?: Record<string, ProfileSchema>
  meta: Schema<S, T>['meta'] & { volatile?: boolean }
  volatile(): ProfileSchema<S, Volatile<T | undefined>>
}

declare const ProfileSchema: {
  new<S = any, T = S>(options: Partial<Schema<S, T>>): ProfileSchema<S, T>
}
export default ProfileSchema
