package io.github.ttalab.kepos.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.ttalab.barekit.host.RuntimeSnapshot
import io.github.ttalab.barekit.host.RuntimeState

@Composable
fun KeposScreen(
  snapshot: RuntimeSnapshot,
  onStart: () -> Unit,
  onStop: () -> Unit,
) {
  MaterialTheme {
    Surface(modifier = Modifier.fillMaxSize()) {
      Column(
        modifier = Modifier.padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
      ) {
        Text(text = "Kepos")
        Text(text = snapshot.state.name.lowercase())
        snapshot.echoUrl?.let { Text(text = it) }
        snapshot.error?.let { Text(text = it, color = MaterialTheme.colorScheme.error) }
        if (snapshot.state == RuntimeState.STOPPED || snapshot.state == RuntimeState.FAILED) {
          Button(onClick = onStart) { Text(text = "Start") }
        } else {
          Button(onClick = onStop, enabled = snapshot.state != RuntimeState.STOPPING) {
            Text(text = "Stop")
          }
        }
      }
    }
  }
}
