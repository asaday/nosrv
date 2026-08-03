import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

function App() {
  const [message, setMessage] = useState("Loading...");
  useEffect(() => {
    fetch("api/hello")
      .then((response) => response.json())
      .then((data) => setMessage(data.message));
  }, []);
  return (
    <main>
      <h1>nosrv + React</h1>
      <p>{message}</p>
    </main>
  );
}

createRoot(document.querySelector("#root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
