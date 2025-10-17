/**
 * Settings-specific error fallback UI
 * Shown when the Settings component crashes
 */
export function SettingsError() {
  const handleGoBack = () => {
    window.location.href = '/';
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      padding: '2rem',
      backgroundColor: 'var(--bg-primary)',
    }}>
      <div style={{ maxWidth: '500px', textAlign: 'center' }}>
        <div style={{ fontSize: '64px', marginBottom: '1rem' }}>⚙️</div>
        <h2 style={{ fontSize: '24px', fontWeight: 600, marginBottom: '1rem' }}>
          Settings Error
        </h2>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>
          The settings page encountered an error. Your settings data might be temporarily unavailable.
        </p>
        <button
          onClick={handleGoBack}
          style={{
            padding: '0.75rem 1.5rem',
            backgroundColor: 'var(--color-primary-600)',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            fontSize: '14px',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Go to Dashboard
        </button>
      </div>
    </div>
  );
}
