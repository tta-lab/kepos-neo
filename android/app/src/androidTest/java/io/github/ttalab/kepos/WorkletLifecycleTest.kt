package io.github.ttalab.kepos

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WorkletLifecycleTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private lateinit var connection: TestServiceConnection

  @Before
  fun startCleanService() {
    context.stopService(Intent(context, KeposForegroundService::class.java))
    KeposForegroundService.start(context)
    connection = TestServiceConnection(context)
  }

  @After
  fun stopService() {
    if (::connection.isInitialized) connection.close()
    context.stopService(Intent(context, KeposForegroundService::class.java))
  }

  @Test
  fun workletAndListenerSurviveActivityRecreationUntilExplicitStop() {
    val binder = connection.awaitBinder()
    val first = binder.awaitState(RuntimeState.RUNNING)
    assertEquals(first.runtimeId, binder.ping().get(10, TimeUnit.SECONDS).runtimeId)
    assertEquals("kepos worklet ok", get(checkNotNull(first.echoUrl)))

    ActivityScenario.launch(MainActivity::class.java).use { activity ->
      activity.recreate()
      val afterRecreate = binder.awaitState(RuntimeState.RUNNING)
      assertEquals(first.runtimeId, afterRecreate.runtimeId)
      assertEquals(first.echoUrl, afterRecreate.echoUrl)
    }

    val afterActivityClosed = binder.awaitState(RuntimeState.RUNNING)
    assertEquals(first.runtimeId, afterActivityClosed.runtimeId)
    assertEquals(first.echoUrl, afterActivityClosed.echoUrl)
    assertEquals(first.runtimeId, binder.ping().get(10, TimeUnit.SECONDS).runtimeId)
    assertEquals("kepos worklet ok", get(checkNotNull(afterActivityClosed.echoUrl)))

    KeposForegroundService.stop(context)
    binder.awaitState(RuntimeState.STOPPED)
    assertThrows(Exception::class.java) { get(checkNotNull(first.echoUrl)) }
  }

  private fun get(url: String): String {
    val connection = URL(url).openConnection() as HttpURLConnection
    connection.connectTimeout = 2_000
    connection.readTimeout = 2_000
    return connection.inputStream.bufferedReader().use { it.readText() }
  }

  private class TestServiceConnection(private val context: Context) : AutoCloseable {
    private val connected = CountDownLatch(1)
    private var binder: KeposForegroundService.LocalBinder? = null
    private val connection = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName, service: IBinder) {
        binder = service as KeposForegroundService.LocalBinder
        connected.countDown()
      }

      override fun onServiceDisconnected(name: ComponentName) {
        binder = null
      }
    }

    init {
      check(
        context.bindService(
          Intent(context, KeposForegroundService::class.java),
          connection,
          Context.BIND_AUTO_CREATE,
        ),
      ) { "failed to bind Kepos service" }
    }

    fun awaitBinder(): KeposForegroundService.LocalBinder {
      check(connected.await(10, TimeUnit.SECONDS)) { "service did not bind" }
      return checkNotNull(binder)
    }

    override fun close() {
      context.unbindService(connection)
    }
  }

  private fun KeposForegroundService.LocalBinder.awaitState(
    expected: RuntimeState,
  ): RuntimeSnapshot {
    val reached = CountDownLatch(1)
    var result: RuntimeSnapshot? = null
    val observer = observe { snapshot ->
      if (snapshot.state == expected) {
        result = snapshot
        reached.countDown()
      }
    }
    try {
      check(reached.await(10, TimeUnit.SECONDS)) { "runtime did not reach $expected" }
      return checkNotNull(result)
    } finally {
      observer.close()
    }
  }
}
