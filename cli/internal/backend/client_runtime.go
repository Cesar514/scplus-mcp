// summary: Backend session runtime helpers.
// FEATURE: Persistent bridge I/O plus request lifecycle.
// inputs: Backend frames, request payloads, and shutdown signals.
// outputs: Typed responses, events, and clean shutdown.
package backend

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync/atomic"
	"time"
)

// Purpose: Start the persistent Node bridge subprocess and attach its pipes.
// Inputs: The resolved Node binary and entry script stored on the client.
// Returns/Effects: Launches the backend process and starts the runtime loops.
func (c *Client) start() error {
	cmd := exec.Command(c.nodeBin, c.entry, "bridge-serve")
	cmd.Env = append(append([]string{}, os.Environ()...), "NODE_NO_WARNINGS=1")
	stdin, stdout, stderr, err := openBackendPipes(cmd)
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start persistent backend session: %w", err)
	}
	c.cmd = cmd
	c.stdin = stdin
	go c.readStdoutLoop(stdout)
	go c.readStderrLoop(stderr)
	go c.waitLoop()
	return nil
}

// Purpose: Open stdin, stdout, and stderr pipes for the backend command.
// Inputs: A prepared exec.Cmd for the Node bridge.
// Returns/Effects: Returns the three pipes or a wrapped OS error.
func openBackendPipes(cmd *exec.Cmd) (io.WriteCloser, io.ReadCloser, io.ReadCloser, error) {
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("open backend stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("open backend stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, nil, nil, fmt.Errorf("open backend stderr pipe: %w", err)
	}
	return stdin, stdout, stderr, nil
}

// Purpose: Wait for backend process exit and publish the disconnect cause.
// Inputs: The running backend process stored on the client.
// Returns/Effects: Records disconnect state and closes the done channel.
func (c *Client) waitLoop() {
	err := c.cmd.Wait()
	if err != nil && !errors.Is(err, os.ErrProcessDone) {
		c.handleDisconnect(fmt.Errorf("persistent backend session exited: %w", err))
	} else {
		c.handleDisconnect(io.EOF)
	}
	close(c.done)
}

// Purpose: Read backend stdout frames and route them to waiters or events.
// Inputs: The backend stdout reader.
// Returns/Effects: Delivers responses, emits events, or records a disconnect error.
func (c *Client) readStdoutLoop(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		if err := c.handleStdoutFrame(scanner.Bytes()); err != nil {
			c.handleDisconnect(err)
			return
		}
	}
	if err := scanner.Err(); err != nil {
		c.handleDisconnect(fmt.Errorf("persistent backend stdout error: %w", err))
	}
}

// Purpose: Decode and route one backend stdout frame.
// Inputs: One JSON frame emitted by the backend bridge.
// Returns/Effects: Routes the frame or returns a disconnect-worthy error.
func (c *Client) handleStdoutFrame(line []byte) error {
	var envelope bridgeResponseFrame
	if err := json.Unmarshal(line, &envelope); err != nil {
		return fmt.Errorf("decode persistent backend frame: %w", err)
	}
	switch envelope.Type {
	case "response":
		c.deliverResponse(envelope)
		return nil
	case "event":
		return c.emitBackendEvent(line)
	default:
		return fmt.Errorf("persistent backend sent unsupported frame type %q", envelope.Type)
	}
}

// Purpose: Deliver one response frame to its pending waiter.
// Inputs: A decoded backend response frame.
// Returns/Effects: Sends the payload or backend error to the waiter channel.
func (c *Client) deliverResponse(frame bridgeResponseFrame) {
	waiterValue, ok := c.pending.LoadAndDelete(frame.ID)
	if !ok {
		return
	}
	waiter := waiterValue.(chan bridgeCallResult)
	if frame.OK {
		waiter <- bridgeCallResult{payload: frame.Result}
		return
	}
	waiter <- bridgeCallResult{err: errors.New(frame.Error)}
}

// Purpose: Decode one backend event frame and emit it on the client event channel.
// Inputs: A raw JSON backend event frame.
// Returns/Effects: Emits the event or returns a decode error.
func (c *Client) emitBackendEvent(line []byte) error {
	var event Event
	if err := json.Unmarshal(line, &event); err != nil {
		return fmt.Errorf("decode backend event: %w", err)
	}
	c.emitEvent(event)
	return nil
}

// Purpose: Read backend stderr lines and surface them as log events.
// Inputs: The backend stderr reader.
// Returns/Effects: Emits stderr log events while the backend is running.
func (c *Client) readStderrLoop(reader io.Reader) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 0, 16*1024), 1024*1024)
	for scanner.Scan() {
		c.emitEvent(Event{
			Kind:    "log",
			Level:   "stderr",
			Message: scanner.Text(),
		})
	}
}

// Purpose: Emit one backend event unless the session is already closing.
// Inputs: One event value produced by stdout or stderr handling.
// Returns/Effects: Sends the event on the channel or drops it after shutdown.
func (c *Client) emitEvent(event Event) {
	select {
	case c.events <- event:
	case <-c.done:
	}
}

// Purpose: Record the disconnect cause and notify all pending callers once.
// Inputs: The disconnect error that ended the backend session.
// Returns/Effects: Stores the error, fails pending calls, and closes the event channel.
func (c *Client) handleDisconnect(err error) {
	c.stopOnce.Do(func() {
		c.errMu.Lock()
		c.connectionErr = err
		c.errMu.Unlock()
		c.pending.Range(func(key, value any) bool {
			waiter := value.(chan bridgeCallResult)
			waiter <- bridgeCallResult{err: c.connectionErrorLocked()}
			c.pending.Delete(key)
			return true
		})
		close(c.events)
	})
}

// Purpose: Return the normalized disconnect error while holding the error lock.
// Inputs: The client connectionErr field.
// Returns/Effects: Returns nil, a normalized EOF error, or the stored error.
func (c *Client) connectionErrorLocked() error {
	if c.connectionErr == nil {
		return nil
	}
	if errors.Is(c.connectionErr, io.EOF) {
		return errors.New("persistent backend session closed")
	}
	return c.connectionErr
}

// Purpose: Read the normalized connection error in a thread-safe way.
// Inputs: The client connectionErr field protected by errMu.
// Returns/Effects: Returns the normalized connection error.
func (c *Client) connectionError() error {
	c.errMu.Lock()
	defer c.errMu.Unlock()
	return c.connectionErrorLocked()
}

// Purpose: Expose the backend event stream to callers.
// Inputs: The client event channel.
// Returns/Effects: Returns the receive-only event channel.
func (c *Client) Events() <-chan Event {
	return c.events
}

// Purpose: Execute one backend command and decode its typed result.
// Inputs: A context, command name, JSON args, and an optional decode target.
// Returns/Effects: Sends the request to the backend and populates the target on success.
func (c *Client) call(ctx context.Context, command string, args map[string]any, target any) error {
	if err := c.connectionError(); err != nil {
		return err
	}
	id, waiter, err := c.registerPendingCall()
	if err != nil {
		return err
	}
	if err := c.writeRequest(command, id, args); err != nil {
		c.pending.Delete(id)
		return err
	}
	return c.awaitCallResult(ctx, command, id, waiter, target)
}

// Purpose: Allocate one pending-call slot for a backend request.
// Inputs: The client pending map and next request counter.
// Returns/Effects: Stores the waiter channel and returns the assigned request ID.
func (c *Client) registerPendingCall() (int64, chan bridgeCallResult, error) {
	id := atomic.AddInt64(&c.nextID, 1)
	waiter := make(chan bridgeCallResult, 1)
	c.pending.Store(id, waiter)
	return id, waiter, nil
}

// Purpose: Encode and write one backend request frame.
// Inputs: The command name, request ID, and optional args object.
// Returns/Effects: Writes one JSON frame to backend stdin or returns a write error.
func (c *Client) writeRequest(command string, id int64, args map[string]any) error {
	request := map[string]any{
		"type":    "request",
		"id":      id,
		"command": command,
	}
	if args != nil {
		request["args"] = args
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("encode backend request %q: %w", command, err)
	}
	c.writeMu.Lock()
	_, writeErr := c.stdin.Write(append(payload, '\n'))
	c.writeMu.Unlock()
	if writeErr != nil {
		return fmt.Errorf("write backend request %q: %w", command, writeErr)
	}
	return nil
}

// Purpose: Wait for one backend request result or context cancellation.
// Inputs: Request metadata, waiter channel, and optional decode target.
// Returns/Effects: Decodes the payload into target or returns the backend failure.
func (c *Client) awaitCallResult(
	ctx context.Context,
	command string,
	id int64,
	waiter chan bridgeCallResult,
	target any,
) error {
	select {
	case result := <-waiter:
		if result.err != nil {
			return fmt.Errorf("backend command %q failed: %w", command, result.err)
		}
		if target == nil {
			return nil
		}
		if err := json.Unmarshal(result.payload, target); err != nil {
			return fmt.Errorf("decode backend result for %q: %w", command, err)
		}
		return nil
	case <-ctx.Done():
		c.pending.Delete(id)
		return fmt.Errorf("backend command %q canceled: %w", command, ctx.Err())
	}
}

// Purpose: Close the persistent backend client and stop the child process.
// Inputs: The running client state plus shutdown timeout policy.
// Returns/Effects: Sends shutdown, waits for exit, and returns any close error.
func (c *Client) Close() error {
	var closeErr error
	c.closeOnce.Do(func() {
		if c.cmd == nil {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		var ignored struct{}
		_ = c.call(ctx, "shutdown", nil, &ignored)
		if c.stdin != nil {
			_ = c.stdin.Close()
		}
		select {
		case <-c.done:
		case <-time.After(3 * time.Second):
			if c.cmd.Process != nil {
				_ = c.cmd.Process.Kill()
			}
			<-c.done
		}
		closeErr = c.connectionError()
		if closeErr != nil && closeErr.Error() == "persistent backend session closed" {
			closeErr = nil
		}
	})
	return closeErr
}
