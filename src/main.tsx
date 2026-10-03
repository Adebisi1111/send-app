import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './tokens.css';
import './index.css';
import './soft.css';
import App from './Pay.tsx'
import { WagmiProvider, createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { arc } from './chain.ts'

const config = createConfig({
  chains: [arc],
  connectors: [injected()],
  transports: { [arc.id]: http() },
})

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)