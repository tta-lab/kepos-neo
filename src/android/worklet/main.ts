import "@tta-lab/kepos-android-worklet";
import { startSubscriber } from "../../runtime/subscriber.js";

// Stage B0 keeps the proven echo host running while forcing bare-pack and
// bare-link to resolve the complete subscriber graph. Stage B1 will make this
// entry own the real subscriber lifecycle.
void startSubscriber;
