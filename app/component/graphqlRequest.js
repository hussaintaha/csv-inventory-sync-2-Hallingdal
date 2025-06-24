const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 70 * 1000;

export const graphqlRequest = async (shopData, query, variables, api_version = "2024-07") => {
    // console.log("dsfsdfdfsddffd------------------sdfdfsdfsd", shopData, "     ", query, "       ", api_version);
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        // console.log("shopData[0]?.shop----------------->", shopData[0]?.shop);
        // console.log("shopData[0]?.accessToken------------>", shopData[0]?.accessToken);

        try {
            const response = await fetch(`https://${shopData[0]?.shop}/admin/api/${api_version}/graphql.json`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Shopify-Access-Token": shopData[0]?.accessToken
                },
                body: JSON.stringify({
                    query: query, ...(variables ? variables : {})
                })
            })

            const data = await response.json();
            // console.log('data===============================================+>', data);


            if (data.errors) {
                if (attempt === MAX_RETRIES) {
                    console.error(`Failed after ${MAX_RETRIES} attempts on data.errors:`, data.errors);

                }
                console.warn(`Retrying request (${attempt}/${MAX_RETRIES}) due to error:`, data.errors);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                continue;

            }

            if (!response.ok) {
                console.error("Response isn't ok of graphql api:", data);

                if (attempt === MAX_RETRIES) {
                    throw new Error(`Failed response isn't ok after ${MAX_RETRIES} attempts: ${JSON.stringify(data.errors)}`);
                }

                console.warn(`Retrying request due to error (${attempt}/${MAX_RETRIES}):`, data.errors);
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                continue;
            }
            return data;
        } catch (error) {
            if (attempt === MAX_RETRIES) {
                console.error(`Failed after ${MAX_RETRIES} attempts:`, error);
                throw error;
            }
            console.warn(`Retrying request (${attempt}/${MAX_RETRIES}) due to error:`, error);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
            continue;

        }
    }
};