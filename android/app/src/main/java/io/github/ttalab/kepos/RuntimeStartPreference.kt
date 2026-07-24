package io.github.ttalab.kepos

import android.content.Context

internal class RuntimeStartPreference(context: Context) {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  fun isEnabled(): Boolean = preferences.getBoolean(ENABLED, true)

  fun setEnabled(enabled: Boolean) {
    check(preferences.edit().putBoolean(ENABLED, enabled).commit()) {
      "failed to persist runtime start preference"
    }
  }

  private companion object {
    const val PREFERENCES = "kepos-runtime"
    const val ENABLED = "enabled"
  }
}
