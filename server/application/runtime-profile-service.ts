import {
  resolveRuntimeProfile,
  type RuntimeProfileOverrides,
} from '../adapters/runtime/runtime-profile'
import type { RuntimeKind, RuntimeProfile } from '../ports/runtime-profile'

export class RuntimeProfileService {
  resolve(runtime: RuntimeKind, overrides?: RuntimeProfileOverrides): RuntimeProfile {
    return resolveRuntimeProfile(runtime, overrides)
  }
}
