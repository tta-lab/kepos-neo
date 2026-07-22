package io.github.ttalab.kepos

import io.github.ttalab.barekit.host.RuntimeState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RuntimeRestartControllerTest {
  @Test
  fun manualStartRecoversStoppedAndFailedRuntimesImmediately() {
    val scheduler = FakeScheduler()
    var starts = 0
    val controller = RuntimeRestartController(scheduler::schedule) { starts++ }

    controller.manualStart(RuntimeState.STOPPED)
    controller.stateChanged(RuntimeState.FAILED)
    controller.manualStart(RuntimeState.FAILED)

    assertEquals(2, starts)
    assertTrue(scheduler.pending.isEmpty())
  }

  @Test
  fun failuresRetryOncePerStateChangeWithCappedBackoff() {
    val scheduler = FakeScheduler()
    var starts = 0
    val controller = RuntimeRestartController(
      schedule = scheduler::schedule,
      startRuntime = { starts++ },
      initialDelayMillis = 1_000,
      maximumDelayMillis = 4_000,
    )

    controller.manualStart(RuntimeState.RUNNING)
    repeat(2) { controller.stateChanged(RuntimeState.FAILED) }
    assertEquals(listOf(1_000L), scheduler.delays)

    repeat(4) {
      scheduler.runNext()
      controller.stateChanged(RuntimeState.FAILED)
    }

    assertEquals(4, starts)
    assertEquals(listOf(1_000L, 2_000L, 4_000L, 4_000L, 4_000L), scheduler.delays)
  }

  @Test
  fun explicitStopCancelsAQueuedRestart() {
    val scheduler = FakeScheduler()
    var starts = 0
    val controller = RuntimeRestartController(scheduler::schedule) { starts++ }
    controller.manualStart(RuntimeState.RUNNING)
    controller.stateChanged(RuntimeState.FAILED)

    controller.stop()
    scheduler.runNext()

    assertEquals(0, starts)
    assertTrue(scheduler.pending.isEmpty())
  }

  private class FakeScheduler {
    val delays = mutableListOf<Long>()
    val pending = ArrayDeque<ScheduledTask>()

    fun schedule(delayMillis: Long, task: () -> Unit): AutoCloseable {
      delays += delayMillis
      val scheduled = ScheduledTask(task)
      pending += scheduled
      return AutoCloseable {
        scheduled.cancelled = true
        pending.remove(scheduled)
      }
    }

    fun runNext() {
      val scheduled = pending.removeFirstOrNull() ?: return
      if (!scheduled.cancelled) scheduled.task()
    }
  }

  private data class ScheduledTask(
    val task: () -> Unit,
    var cancelled: Boolean = false,
  )
}
