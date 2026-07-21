package io.github.ttalab.barekit.host

import io.github.ttalab.barekit.host.protocol.ErrorEnvelope
import io.github.ttalab.barekit.host.protocol.EventEnvelope
import io.github.ttalab.barekit.host.protocol.IpcFrameCodec
import io.github.ttalab.barekit.host.protocol.RequestTracker
import io.github.ttalab.barekit.host.protocol.ResponseEnvelope
import java.io.InputStream
import java.util.concurrent.CompletableFuture
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

interface RuntimeSession : AutoCloseable {
  fun start(
    filename: String,
    source: InputStream,
    arguments: Array<String>,
    onData: (ByteArray) -> Unit,
    onFailure: (Throwable) -> Unit,
  )

  fun write(data: ByteArray, onFailure: (Throwable) -> Unit)
}

fun interface RuntimeTimeoutScheduler {
  fun schedule(delayMillis: Long, task: () -> Unit): AutoCloseable
}

class BareRuntime(
  private val createSession: () -> RuntimeSession,
  createRuntimeId: () -> String,
  private val scheduler: RuntimeTimeoutScheduler,
) : AutoCloseable {
  private val state = RuntimeStateMachine(createRuntimeId)
  private var session: RuntimeSession? = null
  private var codec = IpcFrameCodec()
  private var requests = RequestTracker()
  private var stopRequestId: Long? = null
  private var stopFuture: CompletableFuture<RuntimeSnapshot>? = null
  private var stopTimeout: AutoCloseable? = null
  private val observers = linkedSetOf<(RuntimeSnapshot) -> Unit>()

  fun snapshot(): RuntimeSnapshot = state.snapshot()

  @Synchronized
  fun observe(observer: (RuntimeSnapshot) -> Unit): AutoCloseable {
    observers += observer
    observer(state.snapshot())
    return AutoCloseable {
      synchronized(this) {
        observers -= observer
      }
    }
  }

  @Synchronized
  fun start(
    source: InputStream,
    filename: String = "/kepos.bundle",
  ): RuntimeSnapshot {
    val decision = state.start()
    if (!decision.shouldCreate) {
      source.close()
      return state.snapshot()
    }

    codec = IpcFrameCodec()
    requests = RequestTracker()
    notifyObservers()
    val created = createSession()
    session = created
    try {
      created.start(
        filename,
        source,
        arrayOf(decision.runtimeId),
        { data -> receive(decision.runtimeId, data) },
        { error -> fail(decision.runtimeId, error) },
      )
    } catch (error: Throwable) {
      fail(decision.runtimeId, error)
      throw error
    }
    return state.snapshot()
  }

  @Synchronized
  fun stop(timeoutMillis: Long = 2_000): CompletableFuture<RuntimeSnapshot> {
    require(timeoutMillis >= 0) { "stop timeout must not be negative" }
    stopFuture?.let { return it }
    val current = state.snapshot()
    if (current.state == RuntimeState.STOPPED) {
      return CompletableFuture.completedFuture(current)
    }
    check(current.state == RuntimeState.STARTING || current.state == RuntimeState.RUNNING) {
      "cannot stop a runtime from ${current.state}"
    }
    val runtimeId = checkNotNull(current.runtimeId)
    state.stopping(runtimeId)
    notifyObservers()
    val future = CompletableFuture<RuntimeSnapshot>()
    stopFuture = future
    val request = requests.request("stop")
    stopRequestId = request.id
    stopTimeout = scheduler.schedule(timeoutMillis) { finishStop(runtimeId) }
    session?.write(codec.encode(request)) { error -> fail(runtimeId, error) }
    return future
  }

  @Synchronized
  override fun close() {
    val current = state.snapshot()
    if (current.state == RuntimeState.STOPPED) return
    if (current.state == RuntimeState.STARTING || current.state == RuntimeState.RUNNING) {
      state.stopping(checkNotNull(current.runtimeId))
    }
    if (state.snapshot().state == RuntimeState.STOPPING) {
      finishStop(checkNotNull(state.snapshot().runtimeId))
      return
    }
    closeSession()
  }

  @Synchronized
  private fun receive(runtimeId: String, data: ByteArray) {
    if (state.snapshot().runtimeId != runtimeId) return
    try {
      for (envelope in codec.push(data)) {
        when (envelope) {
          is EventEnvelope -> receiveEvent(runtimeId, envelope)
          is ResponseEnvelope -> receiveResponse(runtimeId, envelope)
          is ErrorEnvelope -> receiveError(runtimeId, envelope)
          else -> throw IllegalArgumentException("runtime sent a request to its host")
        }
      }
    } catch (error: Throwable) {
      fail(runtimeId, error)
    }
  }

  private fun receiveEvent(runtimeId: String, event: EventEnvelope) {
    val data = event.data as? JsonObject
      ?: throw IllegalArgumentException("runtime state event data must be an object")
    if (data["runtimeId"]?.jsonPrimitive?.content != runtimeId) {
      throw IllegalArgumentException("runtime state event has the wrong runtime id")
    }
    if (data["state"]?.jsonPrimitive?.content != "running") return
    val echoUrl = data["echoUrl"]?.jsonPrimitive?.content
      ?: throw IllegalArgumentException("running runtime has no echo URL")
    state.running(runtimeId, echoUrl)
    notifyObservers()
  }

  private fun receiveResponse(runtimeId: String, response: ResponseEnvelope) {
    requests.accept(response)
    if (response.id == stopRequestId) finishStop(runtimeId)
  }

  private fun receiveError(runtimeId: String, error: ErrorEnvelope) {
    requests.accept(error)
    fail(runtimeId, IllegalStateException("${error.error.code}: ${error.error.message}"))
  }

  @Synchronized
  private fun finishStop(runtimeId: String) {
    if (state.snapshot().state != RuntimeState.STOPPING) return
    stopTimeout?.close()
    stopTimeout = null
    closeSession()
    state.stopped(runtimeId)
    val stopped = state.snapshot()
    notifyObservers()
    stopRequestId = null
    stopFuture?.complete(stopped)
    stopFuture = null
  }

  @Synchronized
  private fun fail(runtimeId: String, error: Throwable) {
    if (state.snapshot().runtimeId != runtimeId) return
    stopTimeout?.close()
    stopTimeout = null
    closeSession()
    state.failed(runtimeId, error.message ?: error::class.java.simpleName)
    notifyObservers()
    stopFuture?.completeExceptionally(error)
    stopFuture = null
    stopRequestId = null
  }

  private fun closeSession() {
    session?.close()
    session = null
  }

  private fun notifyObservers() {
    val snapshot = state.snapshot()
    observers.toList().forEach { it(snapshot) }
  }
}
