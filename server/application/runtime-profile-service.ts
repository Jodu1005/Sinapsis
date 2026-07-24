import {
  resolveRuntimeProfile,
  type RuntimeKind,
  type RuntimeProfile,
  type RuntimeProfileOverrides,
} from '../adapters/runtime/runtime-profile'

export class RuntimeProfileService {
  resolve(runtime: RuntimeKind, overrides?: RuntimeProfileOverrides): RuntimeProfile {
    return resolveRuntimeProfile(runtime, overrides)
  }
}
