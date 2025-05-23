import { ddbDocClient, apiGatewayManagementApiClient } from '../utils/awsClients.js';
import { ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { unmarshall } from "@aws-sdk/util-dynamodb";

const CONNECTIONS_TABLE_NAME = process.env.CONNECTIONS_TABLE_NAME;
const MANAGEMENT_API_ENDPOINT = process.env.MANAGEMENT_API_ENDPOINT;

const apiGwClien = MANAGEMENT_API_ENDPOINT ? apiGatewayManagementApiClient(MANAGEMENT_API_ENDPOINT) : null;

export const handler = async (event) => {
    console.log('MANAGEMENT_API_ENDPOINT:', MANAGEMENT_API_ENDPOINT);
    console.log('Received DynamoDB Stream event:', JSON.stringify(event, null, 2));

    if (!apiGwClien) {
        console.error('WebSocket API endpoint is not configured. Cannot notify clients.');
        return { statusCode: 500, body: 'Configuration error.' };
    }

    let connectionIds = [];
    try {
        const scanParams = { TableName: CONNECTIONS_TABLE_NAME, ProjectionExpression: "connectionId" };
        const connections = await ddbDocClient.send(new ScanCommand(scanParams));
        connectionIds = connections.Items?.map(item => item.connectionId) || [];
        console.log(`Found ${connectionIds.length} active connections.`);
    } catch (error) {
        console.error('Error scanning connections table:', error);
        return { statusCode: 500, body: 'Failed to get connections.' };
    }

    if (connectionIds.length === 0) {
        console.log('No active connections found. Nothing to notify.');
        return { statusCode: 200, body: 'No connections.' };
    }

    const promises = event.Records.map(async (record) => {
        if (record.eventName === 'MODIFY') {
            const newImage = record.dynamodb?.NewImage;
            if (!newImage) {
                console.warn('MODIFY event received without NewImage. Skipping record:', record.dynamodb?.SequenceNumber);
                return;
            }
            
            const updatedTask = unmarshall(newImage);
            console.log('Updated task data:', updatedTask);

            const messagePayload = JSON.stringify(updatedTask);
            const postCalls = connectionIds.map(async (connectionId) => {
                try {
                    const command = new PostToConnectionCommand({
                        ConnectionId: connectionId,
                        Data: messagePayload,
                    });
                    await apiGwClien.send(command);
                    console.log(`Message sent to ${connectionId}`);
                } catch (error) {
                    if (error.name === 'GoneException' || error.statusCode === 410) {
                        console.log(`Connection ${connectionId} is stale. Deleting.`);
                        const deleteParams = { TableName: CONNECTIONS_TABLE_NAME, Key: { connectionId } };
                        try {
                            await ddbDocClient.send(new DeleteCommand(deleteParams));
                        } catch (deleteError) {
                            console.error(`Failed to delete stale connection ${connectionId}:`, deleteError);
                        }
                    } else {
                        console.error(`Failed to post to connection ${connectionId}:`, error);
                    }
                }
            });
            
            await Promise.allSettled(postCalls);
        }
    });

    await Promise.allSettled(promises);
    console.log('Finished processing stream records.');
    return { statusCode: 200, body: 'Notifications sent.' };
};
