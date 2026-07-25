import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// StrictMode is intentionally OFF. Its double-invoked effects would build and
// immediately tear down every geometry, material and instance buffer on mount,
// which both doubles load time and makes real disposal bugs impossible to spot.
// Re-enable it temporarily when auditing effect cleanup.
createRoot(document.getElementById('root')).render(<App />);
