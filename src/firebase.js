import { initializeApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator } from "firebase/firestore";
import { getAuth, connectAuthEmulator } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyB2MfCqdi27XdK5Rgj1DcW_lEE73dIfWCY",
  authDomain: "ays105.firebaseapp.com",
  projectId: "ays105",
  storageBucket: "ays105.firebasestorage.app",
  messagingSenderId: "179409393256",
  appId: "1:179409393256:web:7f51655fa852f9e9398ddd"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Yerel deneme: `npm run dev:emu` → canlı veri yerine Firebase emülatörü kullanılır
if (import.meta.env.VITE_EMULATOR === "1") {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
}
