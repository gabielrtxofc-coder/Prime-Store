import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { CatalogProvider } from './context/CatalogContext';
import { CartProvider } from './context/CartContext';
import { OrderProvider } from './context/OrderContext';
import { ToastProvider } from './context/ToastContext';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <CatalogProvider>
        <CartProvider>
          <OrderProvider>
            <ToastProvider>
              <App />
            </ToastProvider>
          </OrderProvider>
        </CartProvider>
      </CatalogProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
