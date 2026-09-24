import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

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
