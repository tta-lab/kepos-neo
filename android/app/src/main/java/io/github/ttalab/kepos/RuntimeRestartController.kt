package io.github.ttalab.kepos

import io.github.ttalab.barekit.host.RuntimeState

internal class RuntimeRestartController(
  private val schedule: (Long, () -> Unit) -> AutoCloseable,
  private val initialDelayMillis: Long = 1_000,
  private val maximumDelayMillis: Long = 30_000,
  private val startRuntime: () -> Unit,
) : AutoCloseable {
  private var enabled = false
  private var nextDelayMillis = initialDelayMillis
  private var pendingRestart: AutoCloseable? = null

  init {
    require(initialDelayMillis > 0) { "initial restart delay must be positive" }
    require(maximumDelayMillis >= initialDelayMillis) {
      "maximum restart delay must not be shorter than the initial delay"
    }
  }

  fun manualStart(state: RuntimeState) {
    val shouldStart = synchronized(this) {
      enabled = true
      pendingRestart?.close()
      pendingRestart = null
      nextDelayMillis = initialDelayMillis
      state == RuntimeState.STOPPED || state == RuntimeState.FAILED
    }
    if (shouldStart) startRuntime()
  }

  @Synchronized
  fun stateChanged(state: RuntimeState) {
    if (!enabled || state != RuntimeState.FAILED || pendingRestart != null) return
    val delayMillis = nextDelayMillis
    nextDelayMillis = (nextDelayMillis * 2).coerceAtMost(maximumDelayMillis)
    pendingRestart = schedule(delayMillis) { retry() }
  }

  @Synchronized
  fun stop() {
    enabled = false
    pendingRestart?.close()
    pendingRestart = null
    nextDelayMillis = initialDelayMillis
  }

  override fun close() = stop()

  private fun retry() {
    val shouldStart = synchronized(this) {
      pendingRestart = null
      enabled
    }
    if (shouldStart) startRuntime()
  }
}
