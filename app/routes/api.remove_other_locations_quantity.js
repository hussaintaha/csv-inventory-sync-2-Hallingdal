import csvParser from "csv-parser";
import path from "path";
import fs from "fs";
import { graphqlRequest } from "../component/graphqlRequest";
import ftp from "basic-ftp";
import prisma from "../db.server";

const {
    FTP_HOST,
    FTP_PORT,
    FTP_USER,
    FTP_PASSWORD,
} = process.env;

const LOCAL_CSV_PATH = path.join(process.cwd(), "public", "CSV", "ic_ean_CSV.csv");

async function downloadCsvFromFtp() {
    const client = new ftp.Client();
    const dir = path.dirname(LOCAL_CSV_PATH);

    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        await client.access({
            host: FTP_HOST,
            port: FTP_PORT,
            user: FTP_USER,
            password: FTP_PASSWORD,
            secure: false,
        });

        await client.downloadTo(LOCAL_CSV_PATH, "/ic_ean_CSV.csv");
        console.log("From downloadCsvFromFtp, downloaded CSV to:", LOCAL_CSV_PATH);
    } catch (error) {
        console.error("FTP download error from downloadCsvFromFtp:", error);
        throw error;
    } finally {
        client.close();
    }
}

async function processRow(row, shopData, counter) {
    const sku = row["PRODUCT_CODE"];
    counter.count++;
    const IS_LOG = counter.count % 1000 === 0;

    if (!sku) return;
    // console.log("this sku processing======================>", sku)
    try {
        const productSKUQuery = `
            query ProductVariantsList {
                productVariants(first: 10, query: "sku:${sku}") {
                    nodes {
                        id
                        title
                        inventoryQuantity
                        inventoryItem {
                            id
                            inventoryLevels(first: 250) {
                                edges {
                                    node {
                                        id
                                        quantities(names: ["available"]) {
                                            quantity
                                        }
                                        location {
                                            id
                                            name
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        `;

        const response = await graphqlRequest(shopData, productSKUQuery);
        const variants = response?.data?.productVariants?.nodes;

        if (IS_LOG) console.log("Processing SKU:", sku, "| Variant Count:", variants.length);

        if (variants.length === 1) {
            const swedenLocationName = "Fjernlager - Leveres innen 4-6 dager";
            const vaasaLocationName = "Fjernlager - Leveres innen 6-8 dager";

            const inventoryItemID = variants[0].inventoryItem.id;
            const inventoryLevels = variants[0].inventoryItem.inventoryLevels.edges;

            const otherInventoryLevels = inventoryLevels.filter(d =>
                d.node.location.name !== swedenLocationName &&
                d.node.location.name !== vaasaLocationName
            );

            if (!otherInventoryLevels.length) {
                if (IS_LOG) console.log("No other locations found to update for SKU:", sku);
                return;
            }

            for (const invLevel of otherInventoryLevels) {
                const qty = invLevel.node.quantities?.[0]?.quantity ?? 0;

                const delta = 0 - qty;

                if (delta === 0) {
                    if (IS_LOG) console.log("Quantity already 0 for location:", invLevel.node.location.name);
                    continue;
                }

                const inventoryAdjustmentMutation = `
                    mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
                        inventoryAdjustQuantities(input: $input) {
                            userErrors {
                                field
                                message
                            }
                            inventoryAdjustmentGroup {
                                createdAt
                                reason
                                changes {
                                    name
                                    delta
                                }
                            }
                        }
                    }
                `;

                if (IS_LOG) {
                    console.log(`Updating location ${invLevel.node.location.name} (ID: ${invLevel.node.location.id}) for SKU: ${sku}`);
                    console.log("Delta:", delta);
                }

                await graphqlRequest(shopData, inventoryAdjustmentMutation, {
                    variables: {
                        input: {
                            reason: "correction",
                            name: "available",
                            changes: [
                                {
                                    delta: delta,
                                    inventoryItemId: inventoryItemID,
                                    locationId: invLevel.node.location.id
                                }
                            ]
                        }
                    }
                });
            }
        } else if (variants.length > 1) {
            if (IS_LOG) console.log("Multiple variants found. Skipping SKU:", sku);
        } else {
            if (IS_LOG) console.log("No variant found for SKU:", sku);
        }
    } catch (err) {
        console.error(`Error processing SKU ${sku}:`, err);
    }
}


async function processCsvStreamed(shopData) {
    return new Promise((resolve, reject) => {
        const counter = { count: 0 };

        const stream = fs.createReadStream(LOCAL_CSV_PATH)
            .pipe(csvParser({ separator: ";" }))

        stream.on("data", async (row) => {
            stream.pause();
            processRow(row, shopData, counter)
                .then(() => stream.resume())
                .catch((err) => {
                    console.error("Error occured on stream.on from remove_other_locations_quantity:", err);
                    stream.resume();
                });
        })

        stream.on("end", () => {
            console.log(`✅ Finished streaming. Total rows processed: ${counter.count}`);
            resolve();
        })

        stream.on("error", (error) => {
            console.error("CSV streaming error from remove_other_locations_quantity :", error);
            reject(error);
        });
    });
}

export const loader = async () => {
    try {
        const shopData = await prisma.session.findMany();
        // const shopData = [{
        //     shop: "mjfdah-nh.myshopify.com",
        //     accessToken: process.env.SHOPIFY_ACCESS_TOKEN
        // }];
        console.log("API triggered of remove_other_locations_quantity, shopData............", shopData);

        await downloadCsvFromFtp();
        await processCsvStreamed(shopData);

        return { success: true };
    } catch (error) {
        console.error("Loader error from remove_other_locations_quantity:", error);
        return new Response(
            JSON.stringify({ error: error, message: "Loader error from remove_other_locations_quantity" }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }
};