import { useState, useCallback } from 'react';
import {
  Page,
  Layout,
  Card,
  Button,
  Text,
} from "@shopify/polaris";

export default function Index() {
  const [loading, setLoading] = useState(false);

  const handleSyncProduct = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/sync_ftp_csv_Products');
      if (!response.ok) throw new Error('Sync failed');
      const data = await response.json();
      console.log("Data received:", data);
    } catch (error) {
      console.error("Error syncing products:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <div style={{ maxWidth: '600px', margin: '120px auto', textAlign: 'center' }}>
            <Card sectioned>
              <Text variant="headingXl" as="h4">
                🚀 Welcome to the Inventory Sync 2 App
              </Text>
              <div style={{ margin: '8px' }}></div>
              <Text variant="headingSm" as="h6">
                Your product inventory syncs automatically from your SFTP folder. Keep your products inventory always up-to-date—no manual work needed!
              </Text>
              <div style={{ margin: '8px' }}></div>
              <Button
                primary
                onClick={handleSyncProduct}
                loading={loading}
                disabled={loading}
              >
                {loading ? 'Syncing Products...' : 'Manually Sync Now'}
              </Button>
            </Card>
          </div>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
