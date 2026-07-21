package io.github.ttalab.barekit.host

import java.io.InputStream
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import to.holepunch.bare.kit.IPC
import to.holepunch.bare.kit.Worklet

class BareKitRuntimeSession(
  memoryLimitBytes: Int = 64 * 1024 * 1024,
) : RuntimeSession {
  private val worklet = Worklet(Worklet.Options().memoryLimit(memoryLimitBytes))
  private var ipc: IPC? = null
  private val closed = AtomicBoolean(false)
  private var receive: ((ByteArray) -> Unit)? = null
  private var fail: ((Throwable) -> Unit)? = null

  override fun start(
    filename: String,
    source: InputStream,
    arguments: Array<String>,
    onData: (ByteArray) -> Unit,
    onFailure: (Throwable) -> Unit,
  ) {
    check(receive == null) { "Bare Kit session has already started" }
    receive = onData
    fail = onFailure
    try {
      worklet.start(filename, source, arguments)
      ipc = IPC(worklet)
      armRead()
    } catch (error: Throwable) {
      onFailure(error)
      throw error
    }
  }

  override fun write(data: ByteArray, onFailure: (Throwable) -> Unit) {
    if (closed.get()) {
      onFailure(IllegalStateException("Bare Kit session is closed"))
      return
    }
    val activeIpc = ipc
    if (activeIpc == null) {
      onFailure(IllegalStateException("Bare Kit IPC has not started"))
      return
    }
    activeIpc.write(ByteBuffer.wrap(data)) { error ->
      if (error != null) onFailure(error)
    }
  }

  override fun close() {
    if (!closed.compareAndSet(false, true)) return
    ipc?.close()
    ipc = null
    worklet.close()
  }

  private fun armRead() {
    if (closed.get()) return
    checkNotNull(ipc).read { buffer, error ->
      if (error != null) {
        fail?.invoke(error)
        return@read
      }
      if (buffer == null) {
        fail?.invoke(IllegalStateException("Bare Kit IPC returned no data"))
        return@read
      }
      val bytes = ByteArray(buffer.remaining())
      buffer.get(bytes)
      receive?.invoke(bytes)
      armRead()
    }
  }
}
