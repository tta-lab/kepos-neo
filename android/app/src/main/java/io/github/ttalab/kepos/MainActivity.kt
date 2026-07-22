package io.github.ttalab.kepos

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Bundle
import android.os.IBinder
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState
import io.github.ttalab.kepos.ui.KeposScreen

class MainActivity : ComponentActivity() {
  private var snapshot by mutableStateOf(RuntimeSnapshot(RuntimeState.STOPPED))
  private var subscription: AutoCloseable? = null
  private var service: KeposForegroundService.LocalBinder? = null
  private var bound = false
  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName, service: IBinder) {
      val binder = service as KeposForegroundService.LocalBinder
      this@MainActivity.service = binder
      subscription = binder.observe { snapshot = it }
    }

    override fun onServiceDisconnected(name: ComponentName) {
      subscription?.close()
      subscription = null
      service = null
      snapshot = RuntimeSnapshot(RuntimeState.STOPPED)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent {
      KeposScreen(
        snapshot = snapshot,
        onStart = { KeposForegroundService.start(this) },
        onStop = { KeposForegroundService.stop(this) },
        onConfigure = { publisherKey ->
          service?.configurePublisher(publisherKey)
        },
      )
    }
  }

  override fun onStart() {
    super.onStart()
    bound = bindService(
      Intent(this, KeposForegroundService::class.java),
      connection,
      Context.BIND_AUTO_CREATE,
    )
  }

  override fun onStop() {
    subscription?.close()
    subscription = null
    service = null
    if (bound) unbindService(connection)
    bound = false
    super.onStop()
  }
}
