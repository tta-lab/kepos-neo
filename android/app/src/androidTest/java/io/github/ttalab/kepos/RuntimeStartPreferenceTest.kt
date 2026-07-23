package io.github.ttalab.kepos

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RuntimeStartPreferenceTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()

  @After
  fun restoreDefault() {
    RuntimeStartPreference(context).setEnabled(true)
  }

  @Test
  fun manualStopSurvivesActivityPreferenceRecreation() {
    val first = RuntimeStartPreference(context)
    first.setEnabled(false)

    assertFalse(RuntimeStartPreference(context).isEnabled())

    RuntimeStartPreference(context).setEnabled(true)
    assertTrue(RuntimeStartPreference(context).isEnabled())
  }
}
