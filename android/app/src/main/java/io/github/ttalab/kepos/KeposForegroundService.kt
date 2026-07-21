package io.github.ttalab.kepos

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import io.github.ttalab.barekit.host.BareKitRuntimeSession
import io.github.ttalab.barekit.host.BareRuntime
import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState
import io.github.ttalab.barekit.host.RuntimeTimeoutScheduler
import java.util.UUID
import java.util.concurrent.CopyOnWriteArraySet

class KeposForegroundService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private val listeners = CopyOnWriteArraySet<(RuntimeSnapshot) -> Unit>()
  private val runtime = BareRuntime(
    { BareKitRuntimeSession() },
    { UUID.randomUUID().toString() },
    RuntimeTimeoutScheduler { delayMillis, task ->
      val runnable = Runnable(task)
      handler.postDelayed(runnable, delayMillis)
      AutoCloseable { handler.removeCallbacks(runnable) }
    },
  )
  private val binder = LocalBinder()
  private var foreground = false
  private lateinit var runtimeObserver: AutoCloseable

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
    runtimeObserver = runtime.observe { snapshot ->
      handler.post {
        listeners.forEach { it(snapshot) }
        if (foreground) {
          getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, notification(snapshot))
        }
      }
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopRuntime()
      return START_NOT_STICKY
    }
    startForeground(NOTIFICATION_ID, notification(runtime.snapshot()))
    foreground = true
    if (runtime.snapshot().state == RuntimeState.STOPPED) {
      runtime.start(assets.open(WORKLET_ASSET))
    }
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder = binder

  override fun onDestroy() {
    runtimeObserver.close()
    runtime.close()
    super.onDestroy()
  }

  private fun stopRuntime() {
    runtime.stop().whenComplete { _, _ ->
      handler.post {
        foreground = false
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
    }
  }

  private fun createNotificationChannel() {
    val channel = NotificationChannel(
      NOTIFICATION_CHANNEL,
      getString(R.string.runtime_channel_name),
      NotificationManager.IMPORTANCE_LOW,
    )
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun notification(snapshot: RuntimeSnapshot): Notification {
    val openApp = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val stop = PendingIntent.getService(
      this,
      1,
      Intent(this, KeposForegroundService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return Notification.Builder(this, NOTIFICATION_CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_upload_done)
      .setContentTitle(getString(R.string.runtime_notification_title))
      .setContentText(snapshot.state.name.lowercase())
      .setContentIntent(openApp)
      .setOngoing(snapshot.state != RuntimeState.STOPPED && snapshot.state != RuntimeState.FAILED)
      .addAction(Notification.Action.Builder(null, getString(R.string.stop), stop).build())
      .build()
  }

  inner class LocalBinder : Binder() {
    fun snapshot(): RuntimeSnapshot = runtime.snapshot()

    fun observe(listener: (RuntimeSnapshot) -> Unit): AutoCloseable {
      listeners += listener
      listener(runtime.snapshot())
      return AutoCloseable { listeners -= listener }
    }
  }

  companion object {
    private const val ACTION_START = "io.github.ttalab.kepos.action.START"
    private const val ACTION_STOP = "io.github.ttalab.kepos.action.STOP"
    private const val NOTIFICATION_CHANNEL = "kepos-runtime"
    private const val NOTIFICATION_ID = 17480
    private const val WORKLET_ASSET = "kepos.bundle"

    fun start(context: Context) {
      context.startForegroundService(
        Intent(context, KeposForegroundService::class.java).setAction(ACTION_START),
      )
    }

    fun stop(context: Context) {
      context.startService(
        Intent(context, KeposForegroundService::class.java).setAction(ACTION_STOP),
      )
    }
  }
}
