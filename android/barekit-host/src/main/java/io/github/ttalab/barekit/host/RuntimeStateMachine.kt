package io.github.ttalab.barekit.host

enum class RuntimeState {
  STOPPED,
  STARTING,
  RUNNING,
  STOPPING,
  FAILED,
}

data class RuntimeSnapshot(
  val state: RuntimeState,
  val runtimeId: String? = null,
  val echoUrl: String? = null,
  val error: String? = null,
)

data class StartDecision(val runtimeId: String, val shouldCreate: Boolean)

class RuntimeStateMachine(private val createRuntimeId: () -> String) {
  private var current = RuntimeSnapshot(RuntimeState.STOPPED)

  @Synchronized
  fun snapshot(): RuntimeSnapshot = current

  @Synchronized
  fun start(): StartDecision {
    val runtimeId = current.runtimeId
    if (current.state == RuntimeState.STARTING || current.state == RuntimeState.RUNNING) {
      checkNotNull(runtimeId)
      return StartDecision(runtimeId, false)
    }
    check(current.state != RuntimeState.STOPPING) {
      "cannot start a runtime while it is stopping"
    }
    val created = createRuntimeId()
    require(created.isNotBlank()) { "runtime id must not be blank" }
    current = RuntimeSnapshot(RuntimeState.STARTING, created)
    return StartDecision(created, true)
  }

  @Synchronized
  fun running(runtimeId: String, echoUrl: String) {
    requireCurrent(runtimeId)
    check(current.state == RuntimeState.STARTING || current.state == RuntimeState.RUNNING) {
      "runtime cannot enter running from ${current.state}"
    }
    current = RuntimeSnapshot(RuntimeState.RUNNING, runtimeId, echoUrl)
  }

  @Synchronized
  fun stopping(runtimeId: String) {
    requireCurrent(runtimeId)
    check(current.state == RuntimeState.STARTING || current.state == RuntimeState.RUNNING) {
      "runtime cannot stop from ${current.state}"
    }
    current = current.copy(state = RuntimeState.STOPPING)
  }

  @Synchronized
  fun stopped(runtimeId: String) {
    requireCurrent(runtimeId)
    check(
      current.state == RuntimeState.STOPPING ||
        current.state == RuntimeState.FAILED,
    ) {
      "runtime cannot enter stopped from ${current.state}"
    }
    current = RuntimeSnapshot(RuntimeState.STOPPED)
  }

  @Synchronized
  fun failed(runtimeId: String?, error: String) {
    if (runtimeId != null) requireCurrent(runtimeId)
    current = RuntimeSnapshot(RuntimeState.FAILED, runtimeId, error = error)
  }

  private fun requireCurrent(runtimeId: String) {
    require(current.runtimeId == runtimeId) {
      "stale runtime callback: $runtimeId"
    }
  }
}
