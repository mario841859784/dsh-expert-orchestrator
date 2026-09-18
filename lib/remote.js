/**
 * dsh-expert-orchestrator — expertSources Typert Remote service (T2/T3 对齐)
 *
 * Root service declared in cordis.patch.yml (`./lib/remote.js`, anchored beside
 * the patch file so the package `exports` map cannot shadow it) so the
 * api-gateway discovers the `expertSources` Remote namespace. The settings
 * page (lib/client.js, T3) mounts the client contribution and calls these
 * methods; the browser never talks to GitHub directly.
 *
 * Contract — namespace/service `expertSources`, one descriptor per method,
 * client side: EXPERT_SOURCES_DESCRIPTORS in lib/client.js. The gateway
 * invokes host implementations POSITIONALLY in descriptor-parameter order and
 * methodParameterNames() rejects destructuring/defaults/rest, so every method
 * below uses plain positional identifier parameters:
 *
 *   getSources()                                          → SourcesSnapshot
 *   addSource(input{url,name}, expectedRevision)           → SourcesSnapshot
 *   removeSource(id, expectedRevision)                     → SourcesSnapshot
 *   setSourceEnabled(id, enabled, expectedRevision, ackRisks?) → SourcesSnapshot
 *   downloadSource(id, channel<'github'|'cdn'>, rev, ackScan?) → SourcesSnapshot
 *   updateSource(id, channel<'github'|'cdn'>, rev, ackScan?)   → SourcesSnapshot
 *   setMirrorPrefixes(prefixes: string[], rev)             → SourcesSnapshot
 *   setDedupChoice(key, sourceId, expectedRevision)        → SourcesSnapshot
 *   clearDedupChoice(key, expectedRevision)                → SourcesSnapshot
 *   saveCustom(input{name,description,prompt,...}, enabled, rev) → SourcesSnapshot
 *   deleteCustom(slug, expectedRevision)                   → SourcesSnapshot
 *   getCustom(slug)                                        → custom expert detail
 *   setExpertEnabled(ref{sourceId,file}, enabled, rev)     → SourcesSnapshot
 *   getExpertContent(ref{sourceId,file})                   → {content}  (read-only)
 *
 * T4 dedup contract (aligned verbatim with the client/protocol ruling):
 * SourcesSnapshot carries `dedupGroups[]` — only groups with >1 member among
 * ENABLED sources: {key, members:[{sourceId,file,name,title}],
 * representative:{sourceId,file}, rule}. Representative priority:
 * dedup.choice[key] (user manual, persisted host-side) > preferLang (registry
 * default 'zh': agency-agents-zh preferred over agency-agents) > registry
 * order > first enabled source. Non-representative members are annotated
 * `shadowed: true` in merged/roster.json — files stay on disk in their own
 * source directories, safety-scan state untouched. setDedupChoice refuses
 * unknown group keys and non-member sourceIds; both new methods share the
 * expectedRevision optimistic lock and the sources-state lock; a no-op
 * (choice already equal / already default) does not bump the revision.
 *
 * setSourceEnabled ack gate (security review M3): enabling a non-registry
 * source (kind='custom') without `ackRisks === true` does not mutate anything
 * and returns the snapshot plus a `confirmRequired` marker; the client shows a
 * confirmation prompt and retries with ackRisks:true. The confirmation is
 * persisted host-side (`confirmedAt`) so later toggles need no ack.
 *
 * downloadSource/updateSource scan gate (scan-policy revision, user ruling):
 * a REGISTRY source whose content trips the security scan is no longer
 * rejected outright. The first attempt without `ackScan === true` registers
 * nothing (revision untouched), persists the findings on the entry
 * (scanFindings + `scanRejected` status with an explanatory statusDetail) and
 * returns the snapshot plus a `confirmRequired` marker (ackField 'ackScan');
 * the client retries with ackScan:true and the source registers with the
 * findings persisted for UI review. Custom/local-path sources keep the hard
 * reject. Symlink members (archives and local trees) are always skipped and
 * recorded on the entry (`skippedSymlinks`), never followed.
 *
 * SourcesSnapshot = { revision, sources[], mirrorPrefixes[], conflicts[],
 * dedupGroups[], recommendedNote }; every mutating method guards the
 * optimistic lock (expectedRevision must equal the stored revision) and
 * failed mutations never bump it.
 *
 * The behavioural truth lives in lib/index.js (buildSourcesSnapshot +
 * remote* helpers); this module only adapts it to the wire. If
 * @deepseek-ai/dsh-typert-protocol is not resolvable (bare dev checkouts —
 * it IS resolvable inside installed profiles), the service degrades to a
 * plain cordis service instead of failing the whole plugin load.
 */

import {
  buildSourcesSnapshot, remoteAddSource, remoteRemoveSource, remoteSetSourceEnabled,
  remoteDownloadSource, remoteSetMirrorPrefixes, remoteSetDedupChoice, remoteClearDedupChoice,
  remoteSaveCustom, remoteDeleteCustom, getCustomExpert, remoteSetExpertEnabled,
  getExpertContent as getExpertContentImpl,
  resolvePresetTargetDir,
} from './index.js'

/** Same target-dir resolution as the plugin deployer (security review M4: the
 *  remote service previously defaulted to `~/.agent-presets` while the deployer
 *  defaults to `~/.dsh/.agent-presets` — both now share resolvePresetTargetDir,
 *  so state always lands in the same tree). DSH_EXPERT_ORCHESTRATOR_TARGET_DIR
 *  exists for tests. */
function resolveTargetDir() {
  if (process.env.DSH_EXPERT_ORCHESTRATOR_TARGET_DIR) return process.env.DSH_EXPERT_ORCHESTRATOR_TARGET_DIR
  return resolvePresetTargetDir()
}

let protocol = null
try {
  protocol = await import('@deepseek-ai/dsh-typert-protocol')
} catch {
  protocol = null
}

/** Apply a typert-protocol Remote marker to a class prototype without native
 *  decorator syntax: call the decorator factory with a minimal context shim,
 *  then run the collected initializer once against a prototype-derived
 *  receiver (mark() is idempotent per prototype). */
function markRemote(klass, methodName, exportName) {
  if (!protocol?.Remote) return
  const initializers = []
  const decorator = protocol.Remote(exportName ?? methodName)
  decorator(undefined, {
    name: methodName,
    private: false,
    static: false,
    addInitializer(fn) { initializers.push(fn) },
  })
  const receiver = Object.create(klass.prototype)
  for (const fn of initializers) fn.call(receiver)
}

function buildMethods() {
  return {
    async getSources() {
      return buildSourcesSnapshot(resolveTargetDir())
    },
    async addSource(input, expectedRevision) {
      return remoteAddSource(resolveTargetDir(), input, expectedRevision)
    },
    async removeSource(id, expectedRevision) {
      return remoteRemoveSource(resolveTargetDir(), id, expectedRevision)
    },
    async setSourceEnabled(id, enabled, expectedRevision, ackRisks) {
      return remoteSetSourceEnabled(resolveTargetDir(), id, enabled, expectedRevision, ackRisks)
    },
    async downloadSource(id, channel, expectedRevision, ackScan) {
      return remoteDownloadSource(resolveTargetDir(), id, channel, expectedRevision, { update: false, ackScan: ackScan === true })
    },
    async updateSource(id, channel, expectedRevision, ackScan) {
      return remoteDownloadSource(resolveTargetDir(), id, channel, expectedRevision, { update: true, ackScan: ackScan === true })
    },
    async setMirrorPrefixes(prefixes, expectedRevision) {
      return remoteSetMirrorPrefixes(resolveTargetDir(), prefixes, expectedRevision)
    },
    async setDedupChoice(key, sourceId, expectedRevision) {
      return remoteSetDedupChoice(resolveTargetDir(), key, sourceId, expectedRevision)
    },
    async clearDedupChoice(key, expectedRevision) {
      return remoteClearDedupChoice(resolveTargetDir(), key, expectedRevision)
    },
    // v2.2 custom experts (per-expert management; Agency expert-library semantics)
    async saveCustom(input, enabled, expectedRevision) {
      return remoteSaveCustom(resolveTargetDir(), input, enabled, expectedRevision)
    },
    async deleteCustom(slug, expectedRevision) {
      return remoteDeleteCustom(resolveTargetDir(), slug, expectedRevision)
    },
    async getCustom(slug) {
      return getCustomExpert(resolveTargetDir(), slug)
    },
    // Custom experts toggle via saveCustom's `enabled` flag — the host refuses
    // setExpertEnabled for the `custom` pseudo-source (single write path rule).
    async setExpertEnabled(ref, enabled, expectedRevision) {
      return remoteSetExpertEnabled(resolveTargetDir(), ref, enabled, expectedRevision)
    },
    // v2.2 read-only persona content accessor (「复制为自定义」预填); the
    // `custom` pseudo-source is refused — own prompts go through getCustom.
    async getExpertContent(ref) {
      return getExpertContentImpl(resolveTargetDir(), ref)
    },
  }
}

const methods = buildMethods()

let ExpertSourcesService
if (protocol?.TypertRemoteService) {
  class ExpertSourcesRemote extends protocol.TypertRemoteService {
    constructor(ctx) {
      super(ctx, 'expertSources')
    }
  }
  for (const [name, fn] of Object.entries(methods)) {
    ExpertSourcesRemote.prototype[name] = fn
    markRemote(ExpertSourcesRemote, name)
  }
  ExpertSourcesService = ExpertSourcesRemote
} else {
  console.warn('[dsh-expert-orchestrator] @deepseek-ai/dsh-typert-protocol unavailable — expertSources remote degrades to a plain service')
  class ExpertSourcesPlain {
    constructor(ctx) { this.ctx = ctx; this.name = 'expertSources' }
  }
  Object.assign(ExpertSourcesPlain.prototype, methods)
  ExpertSourcesService = ExpertSourcesPlain
}

export default ExpertSourcesService
export { ExpertSourcesService }
