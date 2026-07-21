package io.github.ttalab.barekit.host

import io.github.ttalab.barekit.host.protocol.EventEnvelope
import io.github.ttalab.barekit.host.protocol.HostEnvelope
import io.github.ttalab.barekit.host.protocol.IpcFrameCodec
import io.github.ttalab.barekit.host.protocol.RequestEnvelope
import io.github.ttalab.barekit.host.protocol.ResponseEnvelope
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BareRuntimeTest {
  @Test
  fun duplicateStartOwnsOneSessionAndAcknowledgedStopClosesIt() {
    val session = FakeRuntimeSession()
    val scheduler = FakeScheduler()
    val runtime = BareRuntime({ session }, { "runtime-1" }, scheduler)
    val observed = mutableListOf<RuntimeState>()
    runtime.observe { observed += it.state }

    runtime.start(ByteArrayInputStream("bundle".encodeToByteArray()))
    runtime.start(ByteArrayInputStream("unused".encodeToByteArray()))
    session.emit(
      EventEnvelope(
        1,
        "event",
        "runtime.stateChanged",
        buildJsonObject {
          put("state", "running")
          put("runtimeId", "runtime-1")
          put("echoUrl", "http://127.0.0.1:17482/")
        },
      ),
    )

    assertEquals(1, session.starts)
    assertEquals(
      RuntimeSnapshot(
        RuntimeState.RUNNING,
        "runtime-1",
        "http://127.0.0.1:17482/",
      ),
      runtime.snapshot(),
    )

    val stopped = runtime.stop()
    val stopRequest = session.writes.single() as RequestEnvelope
    assertEquals("stop", stopRequest.method)
    assertFalse(stopped.isDone)
    session.emit(
      ResponseEnvelope(
        1,
        "response",
        stopRequest.id,
        buildJsonObject { put("stopped", true) },
      ),
    )

    assertEquals(RuntimeState.STOPPED, stopped.get(1, TimeUnit.SECONDS).state)
    assertEquals(1, session.closes)
    assertTrue(scheduler.cancelled)
    assertEquals(
      listOf(
        RuntimeState.STOPPED,
        RuntimeState.STARTING,
        RuntimeState.RUNNING,
        RuntimeState.STOPPING,
        RuntimeState.STOPPED,
      ),
      observed,
    )
  }

  @Test
  fun stopTimeoutStillClosesTheSession() {
    val session = FakeRuntimeSession()
    val scheduler = FakeScheduler()
    val runtime = BareRuntime({ session }, { "runtime-1" }, scheduler)
    runtime.start(ByteArrayInputStream("bundle".encodeToByteArray()))

    val stopped = runtime.stop(10)
    scheduler.run()

    assertEquals(RuntimeState.STOPPED, stopped.get(1, TimeUnit.SECONDS).state)
    assertEquals(1, session.closes)
  }

  @Test
  fun pingCompletesOnlyAfterTheCurrentWorkletResponds() {
    val session = FakeRuntimeSession()
    val runtime = BareRuntime({ session }, { "runtime-1" }, FakeScheduler())
    runtime.start(ByteArrayInputStream("bundle".encodeToByteArray()))
    session.emit(
      EventEnvelope(
        1,
        "event",
        "runtime.stateChanged",
        buildJsonObject {
          put("state", "running")
          put("runtimeId", "runtime-1")
          put("echoUrl", "http://127.0.0.1:17482/")
        },
      ),
    )

    val ping = runtime.ping()
    val request = session.writes.single() as RequestEnvelope
    assertEquals("ping", request.method)
    assertFalse(ping.isDone)

    session.emit(
      ResponseEnvelope(
        1,
        "response",
        request.id,
        buildJsonObject {
          put("pong", true)
          put("runtimeId", "runtime-1")
        },
      ),
    )

    assertEquals("runtime-1", ping.get(1, TimeUnit.SECONDS).runtimeId)
  }

  private class FakeRuntimeSession : RuntimeSession {
    private val codec = IpcFrameCodec()
    private lateinit var onData: (ByteArray) -> Unit
    var starts = 0
    var closes = 0
    val writes = mutableListOf<HostEnvelope>()

    override fun start(
      filename: String,
      source: InputStream,
      arguments: Array<String>,
      onData: (ByteArray) -> Unit,
      onFailure: (Throwable) -> Unit,
    ) {
      starts++
      this.onData = onData
    }

    override fun write(data: ByteArray, onFailure: (Throwable) -> Unit) {
      writes += codec.push(data)
    }

    fun emit(envelope: HostEnvelope) {
      onData(codec.encode(envelope))
    }

    override fun close() {
      closes++
    }
  }

  private class FakeScheduler : RuntimeTimeoutScheduler {
    private var task: (() -> Unit)? = null
    var cancelled = false

    override fun schedule(delayMillis: Long, task: () -> Unit): AutoCloseable {
      this.task = task
      return AutoCloseable {
        cancelled = true
        this.task = null
      }
    }

    fun run() {
      task?.invoke()
    }
  }
}
