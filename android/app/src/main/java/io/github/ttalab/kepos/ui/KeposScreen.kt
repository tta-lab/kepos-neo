package io.github.ttalab.kepos.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.KeyboardType
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
  onConfigure: (String) -> Unit,
) {
  var publisherKey by rememberSaveable { mutableStateOf("") }
  val clipboard = LocalClipboardManager.current
  MaterialTheme {
    Surface(modifier = Modifier.fillMaxSize()) {
      Column(
        modifier = Modifier.padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
      ) {
        Text(text = "Kepos")
        Text(text = snapshot.state.name.lowercase())
        snapshot.connection?.let { Text(text = "Connection: $it") }
        snapshot.subscriberPublicKey?.let { key ->
          Text(text = "Subscriber: $key")
          Button(onClick = { clipboard.setText(AnnotatedString(key)) }) {
            Text(text = "Copy subscriber key")
          }
        }
        OutlinedTextField(
          value = publisherKey,
          onValueChange = { value ->
            publisherKey = value
              .lowercase()
              .filter { character -> character.isDigit() || character in 'a'..'f' }
              .take(PUBLISHER_KEY_LENGTH)
          },
          label = { Text(text = "Publisher public key") },
          keyboardOptions = KeyboardOptions(
            autoCorrectEnabled = false,
            keyboardType = KeyboardType.Ascii,
          ),
          singleLine = true,
        )
        Button(
          onClick = { onConfigure(publisherKey) },
          enabled = snapshot.state == RuntimeState.RUNNING &&
            PUBLISHER_KEY.matches(publisherKey),
        ) {
          Text(text = "Connect")
        }
        snapshot.homeUrl?.let { url ->
          Text(text = url)
          Button(onClick = { clipboard.setText(AnnotatedString(url)) }) {
            Text(text = "Copy Home URL")
          }
        }
        snapshot.navidromeUrl?.let { url ->
          Text(text = url)
          Button(onClick = { clipboard.setText(AnnotatedString(url)) }) {
            Text(text = "Copy Navidrome URL")
          }
        }
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

private const val PUBLISHER_KEY_LENGTH = 64
private val PUBLISHER_KEY = Regex("^[0-9a-f]{$PUBLISHER_KEY_LENGTH}$")
