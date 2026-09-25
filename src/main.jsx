import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import MakbuzDogrula from './MakbuzDogrula.jsx'

// /makbuz/<kod>: giriş gerektirmeyen makbuz doğrulama sayfası
const makbuzKodu = window.location.pathname.match(/^\/makbuz\/([A-Za-z0-9]{10,40})\/?$/)?.[1]
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>{makbuzKodu ? <MakbuzDogrula kod={makbuzKodu} /> : <App />}</React.StrictMode>
)
