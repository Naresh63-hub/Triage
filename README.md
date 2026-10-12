# TriageFLOW — Smart Emergency Routing 🚨

**TriageFLOW** is an intelligent emergency triage and real-time routing web application designed to help ambulance crews quickly assess patient vitals, calculate triage severity, and match patients to the most suitable nearby hospital with live routing and navigation.

---

## 🌟 Key Features

- **Ambulance Crew Interface**:
  - Fast vital sign logging (Heart Rate, Blood Pressure, SpO2, Respiratory Rate, GCS, Temperature).
  - Automated emergency triage scoring and severity assessment.
  - Smart hospital matching based on patient condition, hospital capabilities (Cardiac, Trauma, Stroke, ICU, etc.), and distance.
- **Interactive Map & Navigation**:
  - Interactive map powered by [Leaflet](https://leafletjs.com/) and OpenStreetMap.
  - Real-time turn-by-turn routing via OSRM (Open Source Routing Machine).
  - Hospital search via Overpass API with reliable local fallbacks.
- **Hospital Emergency Dashboard**:
  - Real-time inbound emergency alerts and patient status overview.
  - Bed availability and incoming triage prioritization.
- **Offline & Local Storage Support**:
  - Persists patient logs and notification history locally using browser `localStorage`.

---

## 🛠️ Tech Stack

- **Frontend**: HTML5, CSS3 (Custom Responsive Design), JavaScript (Vanilla ES6+)
- **Mapping & Routing**: Leaflet.js, OpenStreetMap tiles, OSRM Routing API
- **Hospital Data**: Overpass API / OpenStreetMap with curated local fallback database

---

## 🚀 Getting Started

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Naresh63-hub/Triage.git
   cd Triage
   ```

2. **Run the application:**
   You can run it directly by opening `index.html` in any modern web browser:
   - Double-click `index.html`, OR
   - Serve using VS Code Live Server / any local HTTP server:
     ```bash
     npx serve .
     # or using Python
     python -m http.server 8080
     ```

3. **Access the application:**
   Open `http://localhost:8080` in your browser.

---

## 📁 Project Structure

```
├── index.html        # Main application layout and screens
├── style.css         # Styling, themes, and responsive design
├── app.js            # Core application logic, routing, triage scoring, and map handling
├── rtpfinal.pdf      # Project documentation & report
└── README.md         # Project documentation
```
